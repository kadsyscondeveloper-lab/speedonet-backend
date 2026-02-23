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
    const amtString  = amount.toFixed(2);   // Atom needs "500.00" string format
    const clientcode = String(req.user.id);

    // ── Insert order — columns match dbo.payment_orders schema exactly ──────
    // Schema (from SSMS):
    //   user_id bigint, order_ref nvarchar(64), type nvarchar(30),
    //   provider_id bigint NULL, plan_id bigint NULL, consumer_id nvarchar(100) NULL,
    //   base_amount decimal(10,2), gst_amount decimal(10,2), discount_amount decimal(10,2),
    //   total_amount decimal(10,2), payment_method nvarchar(20), payment_status nvarchar(20),
    //   gateway_name nvarchar(60) NULL, gateway_order_id nvarchar(200) NULL,
    //   gateway_txn_id nvarchar(200) NULL, paid_at datetime2(7) NULL
    await db
      .insertInto('dbo.payment_orders')
      .values({
        user_id:          BigInt(req.user.id),
        order_ref:        orderRef,
        type:             'wallet_recharge',
        provider_id:      null,
        plan_id:          null,
        consumer_id:      clientcode,
        base_amount:      amount,              // decimal — pass number not string
        gst_amount:       0,
        discount_amount:  0,
        total_amount:     amount,
        payment_method:   'atom',              // ← run SQL migration first!
        payment_status:   'pending',
        gateway_name:     'atom',
        gateway_order_id: null,
        gateway_txn_id:   null,
      })
      .execute();

    // ── Get atomTokenId from Atom Auth API ───────────────────────────────────
    const { atomTokenId, mercId, cdnUrl } = await atomService.initiatePayment({
      txnid:      orderRef,
      amt:        amtString,
      clientcode,
    });

    logger.info(`[Payment] Initiated | user=${req.user.id} orderRef=${orderRef} amt=${amtString}`);

    return R.ok(res, {
      atomTokenId,
      mercId,
      cdnUrl,
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
    const encData = req.body.encData || req.body.encdata;
    if (!encData) {
      logger.warn('[Payment] Atom callback received with no encData');
      return R.badRequest(res, 'Missing encData');
    }

    const result = atomService.processCallback(encData);
    const { txnid: orderRef, atomtxnId, bankTxnId, amt, txnStatus, success } = result;

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
        paymentMethod:  'atom',
        gatewayOrderId: atomtxnId,
        gatewayTxnId:   bankTxnId,
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