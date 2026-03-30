// routes/fcm.js
const router           = require('express').Router();
const { body }         = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate }     = require('../middleware/validators');
const { saveToken, clearToken } = require('../services/fcmService');
const R                = require('../utils/response');

// POST /api/v1/fcm/token — register this device's token after login/startup
router.post(
  '/token',
  authenticate,
  [
    body('token').trim().notEmpty().withMessage('FCM token is required'),
    validate,
  ],
  async (req, res, next) => {
    try {
      await saveToken(req.user.id, req.body.token);
      return R.ok(res, null, 'FCM token saved');
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/fcm/token/clear — remove this device's token on logout
// Body: { token: string } — the device's FCM token to remove
// Sending token in body (not DELETE) because Dio doesn't support DELETE with body reliably
router.post(
  '/token/clear',
  authenticate,
  async (req, res, next) => {
    try {
      const token = req.body?.token || null;
      await clearToken(req.user.id, token);
      return R.ok(res, null, 'FCM token cleared');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;