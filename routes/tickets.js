/**
 * routes/tickets.js
 */

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { authenticate }       = require('../middleware/auth');
const { validate }           = require('../middleware/validators');
const ctrl                   = require('../controllers/ticketController');
const { VALID_CATEGORIES }   = require('../services/ticketService');

router.use(authenticate);

// ── Validation ────────────────────────────────────────────────────────────────

const createRules = [
  body('category')
    .trim()
    .notEmpty().withMessage('Category is required')
    .isIn(VALID_CATEGORIES).withMessage(`Must be one of: ${VALID_CATEGORIES.join(', ')}`),

  body('subject')
    .trim()
    .notEmpty().withMessage('Subject is required')
    .isLength({ min: 5, max: 300 }).withMessage('Subject must be 5–300 characters'),

  body('description')
    .trim()
    .notEmpty().withMessage('Description is required')
    .isLength({ min: 10 }).withMessage('Description must be at least 10 characters'),

  body('priority')
    .optional()
    .isIn(['low', 'medium', 'high']).withMessage('Priority must be low, medium, or high'),

  // attachment_data: optional base64 string (like KYC docs)
  body('attachment_data')
    .optional({ nullable: true })
    .isString().withMessage('attachment_data must be a base64 string'),

  body('attachment_mime')
    .optional({ nullable: true })
    .isIn(['image/jpeg', 'image/png', 'application/pdf'])
    .withMessage('Only JPG, PNG and PDF attachments are accepted'),

  validate,
];

const replyRules = [
  body('message')
    .trim()
    .notEmpty().withMessage('Message is required'),

  body('attachment_data')
    .optional({ nullable: true })
    .isString(),

  validate,
];

const paginationRules = [
  query('page') .optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  validate,
];

const ticketIdRule = [
  param('id').isInt({ min: 1 }).withMessage('Ticket ID must be a positive integer'),
  validate,
];

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/',            createRules,     ctrl.createTicket);
router.get('/',             paginationRules, ctrl.getTickets);
router.get('/:id',          ticketIdRule,    ctrl.getTicket);
router.post('/:id/replies', [...ticketIdRule, ...replyRules], ctrl.addReply);

module.exports = router;