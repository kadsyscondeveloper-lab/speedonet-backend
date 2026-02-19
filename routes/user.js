const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { authenticate }       = require('../middleware/auth');
const { validate }           = require('../middleware/validators');
const ctrl                   = require('../controllers/userController');

// All user routes require authentication
router.use(authenticate);

// ── Validation chains ─────────────────────────────────────────────────────────

const profileUpdateRules = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Name must be 2–100 characters'),
  body('email')
    .optional({ nullable: true })
    .trim()
    .isEmail().withMessage('Enter a valid email address')
    .normalizeEmail(),
  validate,
];

const addressRules = [
  body('house_no').optional().trim().isLength({ max: 100 }).withMessage('House/flat no. too long'),
  body('address') .optional().trim().isLength({ max: 300 }).withMessage('Address too long'),
  body('city')    .optional().trim().isLength({ max: 100 }).withMessage('City too long'),
  body('state')   .optional().trim().isLength({ max: 100 }).withMessage('State too long'),
  body('pin_code')
    .optional()
    .trim()
    .matches(/^\d{6}$/).withMessage('PIN code must be 6 digits'),
  validate,
];

const addAddressRules = [
  body('label').optional().trim().isLength({ max: 50 }).withMessage('Label too long'),
  ...addressRules,
];

const kycRules = [
  body('address_proof_type')
    .trim().notEmpty().withMessage('Address proof type is required')
    .isIn(['Rent Agreement', 'Utility Bill', 'Bank Statement', 'Passport', 'Voter ID'])
    .withMessage('Invalid address proof type'),
  body('address_proof_url')
    .trim().notEmpty().withMessage('Address proof URL is required')
    .isURL().withMessage('Must be a valid URL'),
  body('id_proof_type')
    .trim().notEmpty().withMessage('ID proof type is required')
    .isIn(['Passport', 'Aadhar Card', 'Voter ID', 'Driving License', 'PAN Card'])
    .withMessage('Invalid ID proof type'),
  body('id_proof_url')
    .trim().notEmpty().withMessage('ID proof URL is required')
    .isURL().withMessage('Must be a valid URL'),
  validate,
];

const notifQueryRules = [
  query('page') .optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1–100'),
  validate,
];

const markReadRules = [
  body('ids')
    .optional({ nullable: true })
    .isArray().withMessage('ids must be an array')
    .custom((ids) => ids.every(Number.isInteger)).withMessage('Each id must be an integer'),
  validate,
];

const addressParamRule = [
  param('id').isInt({ min: 1 }).withMessage('Address ID must be a positive integer'),
  validate,
];

// =============================================================================
// PROFILE
// =============================================================================

// GET  /api/v1/user/profile          — full profile + address + KYC + referral
router.get('/profile', ctrl.getProfile);

// PUT  /api/v1/user/profile          — update name / email
router.put('/profile', profileUpdateRules, ctrl.updateProfile);

// PUT  /api/v1/user/profile/image    — update profile picture URL
router.put('/profile/image', [
  body('image_url').trim().notEmpty().isURL().withMessage('A valid image URL is required'),
  validate,
], ctrl.updateProfileImage);

// =============================================================================
// ADDRESSES
// =============================================================================

// GET    /api/v1/user/addresses           — list all addresses
router.get('/addresses', ctrl.getAddresses);

// PUT    /api/v1/user/addresses/primary   — upsert primary address
router.put('/addresses/primary', addressRules, ctrl.updatePrimaryAddress);

// POST   /api/v1/user/addresses           — add a secondary address
router.post('/addresses', addAddressRules, ctrl.addAddress);

// DELETE /api/v1/user/addresses/:id       — delete a non-primary address
router.delete('/addresses/:id', addressParamRule, ctrl.deleteAddress);

// =============================================================================
// KYC
// =============================================================================

// GET  /api/v1/user/kyc   — current KYC status
router.get('/kyc', ctrl.getKycStatus);

// POST /api/v1/user/kyc   — submit / re-submit KYC documents
router.post('/kyc', kycRules, ctrl.submitKyc);

// =============================================================================
// NOTIFICATIONS
// =============================================================================

// GET   /api/v1/user/notifications?page=1&limit=20
router.get('/notifications', notifQueryRules, ctrl.getNotifications);

// PATCH /api/v1/user/notifications/read   — body: { ids: [1,2] } or { ids: null }
router.patch('/notifications/read', markReadRules, ctrl.markRead);

// =============================================================================
// REFERRALS
// =============================================================================

// GET /api/v1/user/referrals   — referral code + stats
router.get('/referrals', ctrl.getReferralStats);

module.exports = router;