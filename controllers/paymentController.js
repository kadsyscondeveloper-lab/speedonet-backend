// controllers/paymentController.js
const atomService   = require('../services/atomPaymentService');
const walletService = require('../services/walletService');
const { db, sql }   = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');
const R             = require('../utils/response');
const logger        = require('../utils/logger');

// =============================================================================
// POST /api/v1/payments/atom/initiate
// =============================================================================
async function initiateWalletRecharge(req, res, next) {
  try {
    const amount = parseFloat(req.body.amount);

    if (!amount || isNaN(amount) || amount < 10) {
      return R.badRequest(res, 'Minimum recharge amount is ₹10.');
    }
    if (amount > 50000) {
      return R.badRequest(res, 'Maximum recharge amount is ₹50,000.');
    }

    const orderRef   = generateOrderRef();
    const amtString  = amount.toFixed(2);
    const clientcode = String(req.user.id);

    // ── Fetch user details to pass email/mobile to Atom ──────────────────────
    const userRow = await db
      .selectFrom('dbo.users')
      .select(['phone', 'email'])
      .where('id', '=', BigInt(req.user.id))
      .executeTakeFirst();

    // ── Insert pending order ─────────────────────────────────────────────────
    await db
      .insertInto('dbo.payment_orders')
      .values({
        user_id:          BigInt(req.user.id),
        order_ref:        orderRef,
        type:             'wallet_recharge',
        provider_id:      null,
        plan_id:          null,
        consumer_id:      clientcode,
        base_amount:      amount,
        gst_amount:       0,
        discount_amount:  0,
        total_amount:     amount,
        payment_method:   'atom',
        payment_status:   'pending',
        gateway_name:     'atom',
        gateway_order_id: null,
        gateway_txn_id:   null,
      })
      .execute();

    // ── Call Atom auth API ───────────────────────────────────────────────────
    const { atomUrl, encData } = atomService.initiatePayment({
  txnid: orderRef,
  amt: amtString,
  custEmail: userRow?.email || '',
  custMobile: userRow?.phone || '',
});

logger.info(`[Payment] Legacy initiated | user=${req.user.id} orderRef=${orderRef}`);

return R.ok(res, {
  atomUrl,
  encData,
  orderRef,
  amount: amtString,
}, 'Payment initiated');

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// =============================================================================
// POST /api/v1/payments/atom/callback  (PUBLIC — called by Atom)
// =============================================================================
async function atomCallback(req, res, next) {
  try {
    // processCallback now handles both JSON and legacy encData formats
    const result = atomService.processCallback(req.body);
    const { txnid: orderRef, atomtxnId, bankTxnId, amt, txnStatus, success } = result;

    if (!orderRef) {
      logger.warn('[Payment] Callback missing orderRef / merchTxnId');
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
      logger.info(`[Payment] Duplicate callback ignored for orderRef=${orderRef}`);
      return R.ok(res, null, 'Already processed');
    }

    // ── Update order status ──────────────────────────────────────────────────
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

    // ── Credit wallet on success ─────────────────────────────────────────────
    if (success) {
      const userId = Number(order.user_id);
      const amount = parseFloat(amt || String(order.total_amount));

      // Pass existing order ref so walletService doesn't create a second order
      await walletService.rechargeWallet(userId, {
        amount,
        paymentMethod:  'atom',
        gatewayOrderId: atomtxnId,
        gatewayTxnId:   bankTxnId,
        existingOrderRef: orderRef,   // tells walletService to skip order INSERT
      });
      logger.info(`[Payment] Wallet credited | user=${userId} amt=${amount}`);
    }

    return R.ok(res, { orderRef, success, txnStatus },
      success ? 'Payment successful' : 'Payment failed');

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// =============================================================================
// GET /api/v1/payments/atom/status/:orderRef  (Authenticated — Flutter polls)
// =============================================================================
async function checkPaymentStatus(req, res, next) {
  try {
    const { orderRef } = req.params;

    const order = await db
      .selectFrom('dbo.payment_orders')
      .select([
        'order_ref', 'payment_status', 'total_amount',
        'gateway_txn_id', 'gateway_order_id', 'paid_at',
      ])
      .where('order_ref', '=', orderRef)
      .where('user_id',   '=', BigInt(req.user.id))
      .executeTakeFirst();

    if (!order) return R.notFound(res, 'Order not found');

    return R.ok(res, { order });

  } catch (err) {
    next(err);
  }
}

module.exports = { initiateWalletRecharge, atomCallback, checkPaymentStatus };