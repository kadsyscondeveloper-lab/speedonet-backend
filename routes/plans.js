// routes/plans.js
const router = require('express').Router();
const { param, body, query } = require('express-validator');
const { authenticate }       = require('../middleware/auth');
const { validate }           = require('../middleware/validators');
const { validateCouponForPlan } = require('../services/planService');
const ctrl                   = require('../controllers/planController');

// ── Validation ────────────────────────────────────────────────────────────────

const planIdRule = [
  param('id').isInt({ min: 1 }).withMessage('Plan ID must be a positive integer'),
  validate,
];

const purchaseRules = [
  param('id').isInt({ min: 1 }).withMessage('Plan ID must be a positive integer'),
  body('payment_mode')
    .optional()
    .isIn(['wallet', 'upi', 'card', 'netbanking'])
    .withMessage('Invalid payment mode'),
  validate,
];

const paginationRules = [
  query('page') .optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be 1–50'),
  validate,
];

// ── Public routes ─────────────────────────────────────────────────────────────

router.get('/', ctrl.getPlans);

// ── Authenticated routes ──────────────────────────────────────────────────────

router.use(authenticate);

// IMPORTANT: Specific routes MUST come BEFORE generic :id routes

router.get('/transactions',          paginationRules, ctrl.getTransactions);
router.get('/subscription/active',                    ctrl.getActiveSubscription);
router.get('/subscription/queued',                    ctrl.getQueuedSubscription);   // ← NEW
router.get('/subscription/history',  paginationRules, ctrl.getSubscriptionHistory);

router.post('/coupon/validate', async (req, res, next) => {
  try {
    const { plan_id, coupon_code } = req.body;

    if (!plan_id || !coupon_code) {
      return res.status(400).json({ success: false, message: 'plan_id and coupon_code are required.' });
    }

    const result = await validateCouponForPlan(req.user.id, Number(plan_id), coupon_code);

    return res.json({
      success: true,
      message: `Coupon applied! You save ₹${result.discount_amount.toFixed(2)}`,
      data:    result,
    });
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
});

router.post('/:id/purchase', purchaseRules, ctrl.purchasePlan);
router.get('/:id',           planIdRule,    ctrl.getPlan);

module.exports = router;