/**
 * routes/ticketJobStatus.js
 *
 * User-facing route: check the technician job status of their ticket
 * and get the last known location snapshot.
 *
 * For real-time tracking the user connects via Socket.io:
 *   ws://<host>/tracking/user  →  emit track:ticket { ticket_id }
 */

const router = require('express').Router();
const { param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { validate }     = require('../middleware/validators');
const ctrl             = require('../controllers/ticketJobController');

router.use(authenticate);

// GET /api/v1/tickets/:id/job-status
router.get(
  '/:id/job-status',
  [
    param('id').isInt({ min: 1 }).withMessage('Ticket ID must be a positive integer'),
    validate,
  ],
  ctrl.getUserJobStatus,
);

module.exports = router;