// routes/fcm.js
const router           = require('express').Router();
const { body }         = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate }     = require('../middleware/validators');
const { saveToken }    = require('../services/fcmService');
const R                = require('../utils/response');

// POST /api/v1/fcm/token
// Flutter calls this after getting its FCM token to save it in the DB.
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

module.exports = router;