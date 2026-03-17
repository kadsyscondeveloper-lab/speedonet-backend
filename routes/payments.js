// routes/payments.js
const router          = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate }= require('../middleware/auth');
const { validate }    = require('../middleware/validators');
const ctrl            = require('../controllers/paymentController');

// ── Validation ────────────────────────────────────────────────────────────────

const initiateRules = [
  body('amount')
    .isFloat({ min: 1, max: 50000 })
    .withMessage('Amount must be between ₹1 and ₹50,000'),
  validate,
];

const orderRefRule = [
  param('orderRef').trim().notEmpty().withMessage('orderRef is required'),
  validate,
];

// ── Authenticated ─────────────────────────────────────────────────────────────

router.post('/pg/initiate',         authenticate, initiateRules, ctrl.initiateWalletRecharge);
router.get( '/pg/status/:orderRef', authenticate, orderRefRule,  ctrl.checkPaymentStatus);

// ── Public callbacks (both gateways point here) ───────────────────────────────

// Omniware return_url / return_url_failure / return_url_cancel
router.post('/pg/callback',   ctrl.pgCallback);
router.post('/pg/webhook',    ctrl.pgWebhook);

// Atom return URL (kept separate for clarity, same handler)
router.post('/atom/callback', ctrl.atomCallback);

module.exports = router;