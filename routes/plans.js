// routes/plans.js
const router = require('express').Router();
const { param, body, query } = require('express-validator');
const { authenticate }       = require('../middleware/auth');
const { validate }           = require('../middleware/validators');
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

// List all active plans (no auth needed — shown on plan selection screen)
router.get('/', ctrl.getPlans);

// ── Authenticated routes ──────────────────────────────────────────────────────

router.use(authenticate);

// IMPORTANT: Specific routes MUST come BEFORE generic :id routes
// Otherwise /transactions gets matched as /:id with id='transactions'

// Full transaction history (used by payments screen)
router.get('/transactions', paginationRules, ctrl.getTransactions);

// Current active subscription
router.get('/subscription/active', ctrl.getActiveSubscription);

// Subscription history
router.get('/subscription/history', paginationRules, ctrl.getSubscriptionHistory);

// Purchase a plan (must be before /:id route)
router.post('/:id/purchase', purchaseRules, ctrl.purchasePlan);

// Get single plan details (generic route — MUST be last)
router.get('/:id', planIdRule, ctrl.getPlan);

module.exports = router;