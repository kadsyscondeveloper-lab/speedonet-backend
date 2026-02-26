const { body, validationResult } = require('express-validator');
const R = require('../utils/response');

/**
 * Run after validation chains — returns 400 if any errors exist.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return R.badRequest(res, 'Validation failed', errors.array().map(e => ({
      field:   e.path,
      message: e.msg,
    })));
  }
  next();
}

// ── Reusable rules ────────────────────────────────────────────────────────────

const rules = {
  phone: body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),

  password: body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),

  name: body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be 2–100 characters'),

  email: body('email')
    .optional({ nullable: true })
    .trim()
    .isEmail().withMessage('Enter a valid email address')
    .normalizeEmail(),

  otp: body('otp')
    .trim()
    .notEmpty().withMessage('OTP is required')
    .isLength({ min: 6, max: 6 }).withMessage('OTP must be exactly 6 digits')
    .isNumeric().withMessage('OTP must contain only digits'),

  referralCode: body('referral_code')
    .optional({ nullable: true })
    .trim()
    .isAlphanumeric().withMessage('Invalid referral code'),
};

// ── Validation chains for each endpoint ──────────────────────────────────────

const signupValidation   = [rules.phone, rules.name, rules.email, rules.password, rules.referralCode, validate];
const loginValidation    = [rules.phone, rules.password, validate];
const sendOtpValidation  = [rules.phone, validate];
const verifyOtpValidation = [rules.phone, rules.otp, validate];

const forgotPasswordValidation = [rules.phone, validate];
const resetPasswordValidation  = [
  rules.phone,
  rules.otp,
  body('new_password')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  validate,
];

const changePasswordValidation = [
  body('old_password')
    .notEmpty().withMessage('Old password is required'),
  body('new_password')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  validate,
];

module.exports = {
  validate,
  signupValidation,
  loginValidation,
  sendOtpValidation,
  verifyOtpValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  changePasswordValidation,
};