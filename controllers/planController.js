// controllers/planController.js
const planService = require('../services/planService');
const R           = require('../utils/response');

// GET /api/v1/plans
async function getPlans(req, res, next) {
  try {
    const plans = await planService.getAllPlans();
    return R.ok(res, { plans });
  } catch (err) { next(err); }
}

// GET /api/v1/plans/:id
async function getPlan(req, res, next) {
  try {
    const plan = await planService.getPlanById(parseInt(req.params.id));
    if (!plan) return R.notFound(res, 'Plan not found.');
    return R.ok(res, { plan });
  } catch (err) { next(err); }
}

// POST /api/v1/plans/:id/purchase
async function purchasePlan(req, res, next) {
  try {
    const planId      = parseInt(req.params.id);
    const paymentMode = req.body.payment_mode || 'wallet';
    const couponCode  = req.body.coupon_code  || null;

    if (isNaN(planId)) return R.badRequest(res, 'Invalid plan ID.');

    const result = await planService.purchasePlan(req.user.id, planId, paymentMode, couponCode);

    const msg = result.is_queued
      ? `Plan queued! Starts on ${new Date(result.start_date).toDateString()}.`
      : `Plan activated successfully! Valid until ${new Date(result.expires_at).toDateString()}.`;

    return R.created(res, result, msg);
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// GET /api/v1/plans/subscription/active
async function getActiveSubscription(req, res, next) {
  try {
    const subscription = await planService.getActiveSubscription(req.user.id);
    return R.ok(res, { subscription: subscription || null });
  } catch (err) { next(err); }
}

// GET /api/v1/plans/subscription/queued   ← NEW
// Returns the nearest upcoming subscription (start_date > today).
// Flutter calls this on every load() so the queued plan survives
// screen exits and re-entries.
async function getQueuedSubscription(req, res, next) {
  try {
    const subscription = await planService.getQueuedSubscription(req.user.id);
    return R.ok(res, { subscription: subscription || null });
  } catch (err) { next(err); }
}

// GET /api/v1/plans/subscription/history
async function getSubscriptionHistory(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '10');
    const data  = await planService.getSubscriptionHistory(req.user.id, { page, limit });

    return R.ok(res, data, 'OK', 200, {
      page, limit,
      total:       data.total,
      total_pages: Math.ceil(data.total / limit),
    });
  } catch (err) { next(err); }
}

// GET /api/v1/plans/transactions
async function getTransactions(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1');
    const limit = parseInt(req.query.limit || '10');
    const data  = await planService.getTransactionHistory(req.user.id, { page, limit });

    return R.ok(res, data, 'OK', 200, {
      page, limit,
      total:       data.total,
      total_pages: Math.ceil(data.total / limit),
    });
  } catch (err) { next(err); }
}

module.exports = {
  getPlans,
  getPlan,
  purchasePlan,
  getActiveSubscription,
  getQueuedSubscription,      // ← NEW
  getSubscriptionHistory,
  getTransactions,
};