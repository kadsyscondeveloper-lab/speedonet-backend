// routes/contact.js
const router = require('express').Router();
const { body } = require('express-validator');
const { validate } = require('../middleware/validators');
const { authenticateAdmin } = require('../middleware/adminAuth');
const ctrl = require('../controllers/contactController');
const rateLimit = require('express-rate-limit');

// Prevent spam — 5 submissions per 15 min per IP
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      5,
  message:  { success: false, message: 'Too many submissions. Please try again later.' },
});

const submitRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
  body('phone').optional({ nullable: true }).trim(),
  body('email').optional({ nullable: true }).trim().isEmail().withMessage('Invalid email address').normalizeEmail(),
  body('subject').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('message').trim().notEmpty().withMessage('Message is required').isLength({ min: 10, max: 2000 }),
  validate,
];

// ── Public ────────────────────────────────────────────────────────────────────
router.post('/', contactLimiter, submitRules, ctrl.submitContactInquiry);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/',    authenticateAdmin, ctrl.getContactInquiries);
router.patch('/:id', authenticateAdmin, ctrl.updateContactInquiry);

module.exports = router;