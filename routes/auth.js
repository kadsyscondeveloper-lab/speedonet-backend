const router  = require('express').Router();
const ctrl    = require('../controllers/authController');
const { authenticate }  = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/errorHandler');
const {
  signupValidation,
  loginValidation,
  sendOtpValidation,
  verifyOtpValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
} = require('../middleware/validators');

// ── Public ────────────────────────────────────────────────────────────────────

// Signup
router.post('/signup',          authLimiter, signupValidation,        ctrl.signup);

// Login with password
router.post('/login',           authLimiter, loginValidation,         ctrl.loginWithPassword);

// OTP flow
router.post('/otp/send',        otpLimiter,  sendOtpValidation,       ctrl.sendOtp);
router.post('/otp/verify',      authLimiter, verifyOtpValidation,     ctrl.verifyOtp);

// Forgot / reset password
router.post('/forgot-password', otpLimiter,  forgotPasswordValidation, ctrl.forgotPassword);
router.post('/reset-password',  authLimiter, resetPasswordValidation,  ctrl.resetPassword);

// Token refresh (refresh token in body)
router.post('/refresh',         ctrl.refreshToken);

// ── Protected ─────────────────────────────────────────────────────────────────

router.get ('/me',              authenticate, ctrl.me);
router.post('/logout',          authenticate, ctrl.logout);
router.post('/logout-all',      authenticate, ctrl.logoutAll);

module.exports = router;