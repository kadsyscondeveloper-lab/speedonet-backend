// routes/wallet.js
const router = require('express').Router();
const { body, query } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate }     = require('../middleware/validators');
const ctrl             = require('../controllers/walletController');

router.use(authenticate);

const rechargeRules = [
  body('amount')
    .isFloat({ min: 10, max: 50000 })
    .withMessage('Amount must be between ₹10 and ₹50,000'),
  body('payment_method')
    .optional()
    .isIn(['upi', 'card', 'netbanking', 'wallet'])
    .withMessage('Invalid payment method'),
  validate,
];

const paginationRules = [
  query('page') .optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  validate,
];

router.get('/balance',          ctrl.getBalance);
router.get('/transactions',     paginationRules, ctrl.getTransactions);
router.post('/recharge',        rechargeRules,   ctrl.recharge);

module.exports = router;