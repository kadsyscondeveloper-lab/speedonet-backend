// routes/payments.js
const router          = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate }= require('../middleware/auth');
const { validate }    = require('../middleware/validators');
const ctrl            = require('../controllers/paymentController');

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

// Authenticated
router.post('/atom/initiate',         authenticate, initiateRules, ctrl.initiateWalletRecharge);
router.get( '/atom/status/:orderRef', authenticate, orderRefRule,  ctrl.checkPaymentStatus);

// Public — Atom POSTs callback here
router.post('/atom/callback',         ctrl.atomCallback);

module.exports = router;