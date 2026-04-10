// routes/aiSupport.js

const router = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate }     = require('../middleware/validators');
const ctrl             = require('../controllers/aiSupportController');
const rateLimit        = require('express-rate-limit');

// Tighter rate limit for AI endpoints (each call hits Anthropic's API)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max:      20,
  keyGenerator: (req) => req.user?.id || req.ip,
  handler:  (req, res) => res.status(429).json({ success: false, message: 'Too many messages. Please wait a moment.' }),
});

router.use(authenticate);

const msgRules = [
  body('message').trim().notEmpty().withMessage('message is required')
    .isLength({ max: 2000 }).withMessage('Message too long'),
  validate,
];

const sessionIdRule = [
  param('id').isInt({ min: 1 }).withMessage('Invalid session ID'),
  validate,
];

router.post('/sessions',              ctrl.startSession);
router.get('/sessions',               ctrl.getSessions);
router.get('/sessions/:id',           sessionIdRule,              ctrl.getSession);
router.post('/sessions/:id/message',  [...sessionIdRule, ...msgRules], aiLimiter, ctrl.sendMessage);

module.exports = router;
