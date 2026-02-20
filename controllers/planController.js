// controllers/planController.js
const planService = require('../services/planService');
const R           = require('../utils/response');

// =============================================================================
// GET /api/v1/plans
// Public — lists all active Speedonet plans
// =============================================================================
async function getPlans(req, res, next) {
  try {
    const plans = await planService.getAllPlans();
    return R.ok(res, { plans });
  } catch (err) { next(err); }
}

// =============================================================================
// GET /api/v1/plans/:id
// =============================================================================
async function getPlan(req, res, next) {
  try {
    const plan = await planService.getPlanById(parseInt(req.params.id));
    if (!plan) return R.notFound(res, 'Plan not found.');
    return R.ok(res, { plan });
  } catch (err) { next(err); }
}

// =============================================================================
// POST /api/v1/plans/:id/purchase
// Authenticated — buy a plan
// Body: { payment_mode: 'wallet' }
// =============================================================================
async function purchasePlan(req, res, next) {
  try {
    const planId      = parseInt(req.params.id);
    const paymentMode = req.body.payment_mode || 'wallet';

    if (isNaN(planId)) return R.badRequest(res, 'Invalid plan ID.');

    const result = await planService.purchasePlan(req.user.id, planId, paymentMode);

    const expiryDisplay = new Date(result.expires_at).toDateString();
    return R.created(res, result, `Plan activated successfully! Valid until ${expiryDisplay}.`);
  } catch (err) {
    // Forward our custom statusCode errors cleanly
    if (err.statusCode) {
      return R.error(res, err.message, err.statusCode);
    }
    next(err);
  }
}

// =============================================================================
// GET /api/v1/plans/subscription/active
// Authenticated — get user's current active plan
// =============================================================================
async function getActiveSubscription(req, res, next) {
  try {
    const subscription = await planService.getActiveSubscription(req.user.id);
    return R.ok(res, { subscription: subscription || null });
  } catch (err) { next(err); }
}

// =============================================================================
// GET /api/v1/plans/subscription/history
// Authenticated — get user's plan history
// =============================================================================
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

// =============================================================================
// GET /api/v1/plans/transactions
// Authenticated — full transaction history (for payments screen)
// =============================================================================
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
  getSubscriptionHistory,
  getTransactions,
};

//small change