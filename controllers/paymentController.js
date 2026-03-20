// controllers/paymentController.js
const gatewayService       = require('../services/gatewayService');
const walletService        = require('../services/walletService');
const { db, sql }          = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');
const R                    = require('../utils/response');
const logger               = require('../utils/logger');

// =============================================================================
// POST /api/v1/payments/pg/initiate  (Authenticated)
// =============================================================================
async function initiateWalletRecharge(req, res, next) {
  try {
    const amount = parseFloat(req.body.amount);

    if (!amount || isNaN(amount) || amount < 1)
      return R.badRequest(res, 'Minimum recharge amount is ₹1.');
    if (amount > 50000)
      return R.badRequest(res, 'Maximum recharge amount is ₹50,000.');

    const amtString = amount.toFixed(2);

    const requestedGateway = (req.body.gateway || '').toLowerCase();
    const gateway = ['atom', 'omniware'].includes(requestedGateway)
      ? requestedGateway
      : gatewayService.getActiveGateway();

    logger.info(`[Payment] Gateway=${gateway} | user=${req.user.id}`);

    const userRow = await db
      .selectFrom('dbo.users')
      .select(['phone', 'email', 'name'])
      .where('id', '=', BigInt(req.user.id))
      .executeTakeFirst();

    // Expire all previous pending orders for this user + gateway
    await db
      .updateTable('dbo.payment_orders')
      .set({ payment_status: 'failed', updated_at: sql`SYSUTCDATETIME()` })
      .where('user_id',        '=', BigInt(req.user.id))
      .where('type',           '=', 'wallet_recharge')
      .where('payment_status', '=', 'pending')
      .where('gateway_name',   '=', gateway)
      .execute();

    const orderRef = generateOrderRef();

    // ── Store base_amount = the amount the USER requested (before gateway fees) ──
    // total_amount here is also the user's amount — gateway fees are their own cost,
    // not something we credit to the wallet.
    await db
      .insertInto('dbo.payment_orders')
      .values({
        user_id:          BigInt(req.user.id),
        order_ref:        orderRef,
        type:             'wallet_recharge',
        plan_id:          null,
        base_amount:      amtString,
        gst_amount:       '0',
        discount_amount:  '0',
        total_amount:     amtString,   // ← user's requested amount, NOT gateway total
        payment_method:   gateway,
        payment_status:   'pending',
        gateway_name:     gateway,
        gateway_order_id: null,
        gateway_txn_id:   null,
      })
      .execute();

    logger.info(`[Payment] Order created | user=${req.user.id} orderRef=${orderRef} gateway=${gateway}`);

    const result = await gatewayService.initiatePayment({
      orderRef,
      amount:          amtString,
      user:            userRow || {},
      gatewayOverride: gateway,
    });

    return R.ok(res, result, 'Payment initiated');

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// =============================================================================
// POST /api/v1/payments/pg/callback  (PUBLIC — Omniware)
// POST /api/v1/payments/atom/callback (PUBLIC — Atom SDK returnUrl)
// =============================================================================
async function pgCallback(req, res, next) {
  try {
    logger.info(`[Payment] Callback body: ${JSON.stringify(req.body)}`);

    let result;
    try {
      result = await gatewayService.processCallback(req.body);
    } catch (err) {
      logger.error(`[Payment] Callback parse error: ${err.message}`);
      return R.badRequest(res, err.message);
    }

    const { success, orderRef, transactionId } = result;
    // NOTE: We intentionally ignore `result.amount` (the gateway's charged amount
    // which includes platform fees). We always credit only what the user requested,
    // which is stored in order.total_amount.

    if (!orderRef) {
      logger.warn('[Payment] Callback missing orderRef');
      return R.badRequest(res, 'Missing order reference');
    }

    const order = await db
      .selectFrom('dbo.payment_orders')
      .select(['id', 'user_id', 'total_amount', 'payment_status', 'gateway_name'])
      .where('order_ref', '=', orderRef)
      .executeTakeFirst();

    if (!order) {
      logger.error(`[Payment] Unknown orderRef in callback: ${orderRef}`);
      return R.notFound(res, 'Order not found');
    }

    // Idempotency — ignore duplicate callbacks
    if (order.payment_status === 'success') {
      logger.info(`[Payment] Duplicate callback ignored | orderRef=${orderRef}`);
      if (order.gateway_name === 'atom') return res.status(200).send('OK');
      return R.ok(res, null, 'Already processed');
    }

    await db
      .updateTable('dbo.payment_orders')
      .set({
        payment_status: success ? 'success' : 'failed',
        gateway_txn_id: transactionId || null,
        paid_at:        success ? new Date() : null,
        updated_at:     sql`SYSUTCDATETIME()`,
      })
      .where('order_ref', '=', orderRef)
      .execute();

    if (success) {
      const userId = Number(order.user_id);

      // ── FIX: Always credit order.total_amount (the user's requested amount),
      //         never the gateway's returned amount (which includes their fees).
      const creditAmt = parseFloat(String(order.total_amount));

      logger.info(
        `[Payment] Crediting wallet | user=${userId} ` +
        `creditAmt=${creditAmt} (order.total_amount) | orderRef=${orderRef}`
      );

      await walletService.rechargeWallet(userId, {
        amount:           creditAmt,
        paymentMethod:    order.gateway_name || 'pg',
        gatewayTxnId:     transactionId,
        existingOrderRef: orderRef,
      });

      logger.info(`[Payment] Wallet credited | user=${userId} amt=${creditAmt} order=${orderRef}`);
    }

    if (order.gateway_name === 'atom') {
      return res.status(200).send('OK');
    }

    return R.ok(
      res,
      { orderRef, success, responseCode: result.responseCode },
      success ? 'Payment successful' : 'Payment failed'
    );

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// =============================================================================
// GET /api/v1/payments/pg/status/:orderRef  (Authenticated)
// =============================================================================
async function checkPaymentStatus(req, res, next) {
  try {
    const { orderRef } = req.params;

    const order = await db
      .selectFrom('dbo.payment_orders')
      .select([
        'order_ref', 'payment_status', 'total_amount',
        'gateway_txn_id', 'gateway_order_id', 'gateway_name', 'paid_at',
      ])
      .where('order_ref', '=', orderRef)
      .where('user_id',   '=', BigInt(req.user.id))
      .executeTakeFirst();

    if (!order) return R.notFound(res, 'Order not found');

    return R.ok(res, { order });

  } catch (err) { next(err); }
}

// =============================================================================
// POST /api/v1/payments/pg/webhook  (PUBLIC — server-to-server)
// =============================================================================
async function pgWebhook(req, res, next) {
  return pgCallback(req, res, next);
}

// =============================================================================
// Atom callback also routes here (separate path for clarity)
// POST /api/v1/payments/atom/callback
// =============================================================================
async function atomCallback(req, res, next) {
  return pgCallback(req, res, next);
}

module.exports = {
  initiateWalletRecharge,
  pgCallback,
  atomCallback,
  checkPaymentStatus,
  pgWebhook,
};