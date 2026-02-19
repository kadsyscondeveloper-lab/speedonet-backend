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

// ── KYC validation — accepts base64 document data ─────────────────────────────
const ALLOWED_PROOF_TYPES_ADDRESS = ['Rent Agreement', 'Utility Bill', 'Bank Statement', 'Passport', 'Voter ID'];
const ALLOWED_PROOF_TYPES_ID      = ['Passport', 'Aadhar Card', 'Voter ID', 'Driving License', 'PAN Card'];
const ALLOWED_MIME_TYPES          = ['image/jpeg', 'image/png', 'application/pdf'];

// Rough size check: a 5MB file ≈ 6.8MB base64 string ≈ 7,143,936 chars
const MAX_BASE64_CHARS = 7_500_000;

const kycRules = [
  body('address_proof_type')
    .trim()
    .notEmpty().withMessage('Address proof type is required')
    .isIn(ALLOWED_PROOF_TYPES_ADDRESS).withMessage('Invalid address proof type'),

  body('address_proof_data')
    .notEmpty().withMessage('Address proof document is required')
    .isString().withMessage('Document data must be a base64 string')
    .custom((val) => {
      if (val.length > MAX_BASE64_CHARS) throw new Error('Address proof file is too large (max 5 MB)');
      return true;
    }),

  body('address_proof_mime')
    .trim()
    .notEmpty().withMessage('Address proof MIME type is required')
    .isIn(ALLOWED_MIME_TYPES).withMessage('Only JPG, PNG and PDF are accepted for address proof'),

  body('id_proof_type')
    .trim()
    .notEmpty().withMessage('ID proof type is required')
    .isIn(ALLOWED_PROOF_TYPES_ID).withMessage('Invalid ID proof type'),

  body('id_proof_data')
    .notEmpty().withMessage('ID proof document is required')
    .isString().withMessage('Document data must be a base64 string')
    .custom((val) => {
      if (val.length > MAX_BASE64_CHARS) throw new Error('ID proof file is too large (max 5 MB)');
      return true;
    }),

  body('id_proof_mime')
    .trim()
    .notEmpty().withMessage('ID proof MIME type is required')
    .isIn(ALLOWED_MIME_TYPES).withMessage('Only JPG, PNG and PDF are accepted for ID proof'),

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
router.get('/profile',        ctrl.getProfile);
router.put('/profile',        profileUpdateRules, ctrl.updateProfile);
router.put('/profile/image', [
  body('image_url').trim().notEmpty().isURL().withMessage('A valid image URL is required'),
  validate,
], ctrl.updateProfileImage);

// =============================================================================
// ADDRESSES
// =============================================================================
router.get   ('/addresses',          ctrl.getAddresses);
router.put   ('/addresses/primary',  addressRules,    ctrl.updatePrimaryAddress);
router.post  ('/addresses',          addAddressRules, ctrl.addAddress);
router.delete('/addresses/:id',      addressParamRule, ctrl.deleteAddress);

// =============================================================================
// KYC
// =============================================================================
router.get ('/kyc', ctrl.getKycStatus);
router.post('/kyc', kycRules, ctrl.submitKyc);

// =============================================================================
// NOTIFICATIONS
// =============================================================================
router.get  ('/notifications',      notifQueryRules, ctrl.getNotifications);
router.patch('/notifications/read', markReadRules,   ctrl.markRead);

// =============================================================================
// REFERRALS
// =============================================================================
router.get('/referrals', ctrl.getReferralStats);

module.exports = router;