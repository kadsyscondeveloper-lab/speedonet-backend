// controllers/paymentController.js
const atomService          = require('../services/atomPaymentService');
const walletService        = require('../services/walletService');
const { db, sql }          = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');
const R                    = require('../utils/response');
const logger               = require('../utils/logger');

// =============================================================================
// POST /api/v1/payments/atom/initiate  (Authenticated)
// =============================================================================
async function initiateWalletRecharge(req, res, next) {
  try {
    const amount = parseFloat(req.body.amount);

    if (!amount || isNaN(amount) || amount < 1)
      return R.badRequest(res, 'Minimum recharge amount is ₹1.');
    if (amount > 50000)
      return R.badRequest(res, 'Maximum recharge amount is ₹50,000.');

    const orderRef  = generateOrderRef();
    const amtString = amount.toFixed(2);

    // dbo.users has a single 'name' column — not 'first_name'/'last_name'
    const userRow = await db
      .selectFrom('dbo.users')
      .select(['phone', 'email', 'name'])
      .where('id', '=', BigInt(req.user.id))
      .executeTakeFirst();

    // Split single name into first/last for the Atom SDK
    const fullName  = userRow?.name || '';
    const spaceIdx  = fullName.indexOf(' ');
    const firstName = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    const lastName  = spaceIdx === -1 ? ''       : fullName.slice(spaceIdx + 1);

    await db
      .insertInto('dbo.payment_orders')
      .values({
        user_id:          BigInt(req.user.id),
        order_ref:        orderRef,
        type:             'wallet_recharge',
        provider_id:      null,
        plan_id:          null,
        base_amount:      String(amount),
        gst_amount:       '0',
        discount_amount:  '0',
        total_amount:     String(amount),
        payment_method:   'atom',
        payment_status:   'pending',
        gateway_name:     'atom',
        gateway_order_id: null,
        gateway_txn_id:   null,
      })
      .execute();

    logger.info(`[Payment] Initiated | user=${req.user.id} orderRef=${orderRef} amt=${amtString}`);

    // Generate encData for Atom gateway
    const { atomUrl, encData } = atomService.initiatePayment({
      txnid:      orderRef,
      amt:        amtString,
      custEmail:  userRow?.email || '',
      custMobile: userRow?.phone || '',
    });

    return R.ok(res, {
      orderRef,
      amount:        amtString,
      custEmail:     userRow?.email || '',
      custMobile:    userRow?.phone || '',
      custFirstName: firstName,
      custLastName:  lastName,
      atomUrl,
      encData,
    }, 'Payment initiated');

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// =============================================================================
// POST /api/v1/payments/atom/callback  (PUBLIC — Atom webhooks here)
// =============================================================================
async function atomCallback(req, res, next) {
  try {
    const result = atomService.processCallback(req.body);
    const { txnid: orderRef, atomtxnId, bankTxnId, amt, txnStatus, success } = result;

    if (!orderRef) {
      logger.warn('[Payment] Callback missing orderRef');
      return R.badRequest(res, 'Missing transaction reference');
    }

    const order = await db
      .selectFrom('dbo.payment_orders')
      .select(['id', 'user_id', 'total_amount', 'payment_status'])
      .where('order_ref',    '=', orderRef)
      .where('gateway_name', '=', 'atom')
      .executeTakeFirst();

    if (!order) {
      logger.error(`[Payment] Callback for unknown orderRef: ${orderRef}`);
      return R.notFound(res, 'Order not found');
    }

    if (order.payment_status === 'success') {
      logger.info(`[Payment] Duplicate callback ignored | orderRef=${orderRef}`);
      return R.ok(res, null, 'Already processed');
    }

    await db
      .updateTable('dbo.payment_orders')
      .set({
        payment_status:   success ? 'success' : 'failed',
        gateway_order_id: atomtxnId || null,
        gateway_txn_id:   bankTxnId || null,
        paid_at:          success ? new Date() : null,
        updated_at:       sql`SYSUTCDATETIME()`,
      })
      .where('order_ref', '=', orderRef)
      .execute();

    if (success) {
      const userId = Number(order.user_id);
      const amount = parseFloat(amt || String(order.total_amount));
      await walletService.rechargeWallet(userId, {
        amount,
        paymentMethod:    'atom',
        gatewayOrderId:   atomtxnId,
        gatewayTxnId:     bankTxnId,
        existingOrderRef: orderRef,
      });
      logger.info(`[Payment] Wallet credited | user=${userId} amt=${amount} orderRef=${orderRef}`);
    }

    return R.ok(res, { orderRef, success, txnStatus },
      success ? 'Payment successful' : 'Payment failed');

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// =============================================================================
// GET /api/v1/payments/atom/status/:orderRef  (Authenticated)
// =============================================================================
async function checkPaymentStatus(req, res, next) {
  try {
    const { orderRef } = req.params;

    const order = await db
      .selectFrom('dbo.payment_orders')
      .select(['order_ref', 'payment_status', 'total_amount',
               'gateway_txn_id', 'gateway_order_id', 'paid_at'])
      .where('order_ref', '=', orderRef)
      .where('user_id',   '=', BigInt(req.user.id))
      .executeTakeFirst();

    if (!order) return R.notFound(res, 'Order not found');
    return R.ok(res, { order });

  } catch (err) { next(err); }
}

module.exports = {
  initiateWalletRecharge,
  atomCallback,
  checkPaymentStatus,
};