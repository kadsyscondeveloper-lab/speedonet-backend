// controllers/walletController.js
const walletService = require('../services/walletService');
const R             = require('../utils/response');

async function getBalance(req, res, next) {
  try {
    const balance = await walletService.getWalletBalance(req.user.id);
    return R.ok(res, { balance });
  } catch (err) { next(err); }
}

async function getTransactions(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '20');
    const data  = await walletService.getWalletTransactions(req.user.id, { page, limit });
    return R.ok(res, data, 'OK', 200, {
      page, limit,
      total:       data.total,
      total_pages: Math.ceil(data.total / limit),
    });
  } catch (err) { next(err); }
}

/**
 * POST /wallet/recharge
 * Body: { amount: number, payment_method: string }
 *
 * ── Gateway integration point ──────────────────────────────────────────────
 * When you add Razorpay:
 *   1. Create a Razorpay order FIRST and return order_id to the app
 *   2. App completes payment, sends back { razorpay_order_id, razorpay_payment_id, signature }
 *   3. Verify signature here, THEN call walletService.rechargeWallet()
 *
 * For now, auto-confirms so you can test the full flow.
 * ──────────────────────────────────────────────────────────────────────────
 */
async function recharge(req, res, next) {
  try {
    const { amount, payment_method = 'upi' } = req.body;

    if (!amount || isNaN(parseFloat(amount))) {
      return R.badRequest(res, 'Invalid amount.');
    }

    const result = await walletService.rechargeWallet(req.user.id, {
      amount,
      paymentMethod:  payment_method,
      gatewayOrderId: req.body.gateway_order_id  || null,
      gatewayTxnId:   req.body.gateway_txn_id    || null,
    });

    return R.created(res, result, `₹${parseFloat(amount).toFixed(2)} added to your wallet successfully!`);
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

module.exports = { getBalance, getTransactions, recharge };