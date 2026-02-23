// routes/payments.js
const router = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate }     = require('../middleware/validators');
const ctrl             = require('../controllers/paymentController');

// ── Validation ────────────────────────────────────────────────────────────────

const initiateRules = [
  body('amount')
    .isFloat({ min: 10, max: 50000 })
    .withMessage('Amount must be between ₹10 and ₹50,000'),
  validate,
];

const orderRefRule = [
  param('orderRef')
    .trim()
    .notEmpty()
    .withMessage('orderRef is required'),
  validate,
];

// ── Routes ────────────────────────────────────────────────────────────────────

// Authenticated — initiate payment
router.post('/atom/initiate', authenticate, initiateRules, ctrl.initiateWalletRecharge);

// Authenticated — poll payment status after WebView closes
router.get('/atom/status/:orderRef', authenticate, orderRefRule, ctrl.checkPaymentStatus);

// PUBLIC — Atom calls this after payment (no auth, verified by hash instead)
router.post('/atom/callback', ctrl.atomCallback);

module.exports = router;