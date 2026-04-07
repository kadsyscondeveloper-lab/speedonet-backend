/**
 * routes/ticketJobs.js
 *
 * Technician-facing support-job routes.
 * Mount in routes/index.js:
 *   router.use('/technician', require('./ticketJobs'));
 *
 * (already under /technician since that's where authenticateTechnician lives)
 */

const router = require('express').Router();
const { param, query, body } = require('express-validator');
const { authenticateTechnician } = require('../middleware/technicianAuth');
const { validate }               = require('../middleware/validators');
const ctrl                       = require('../controllers/ticketJobController');

router.use(authenticateTechnician);

// GET  /technician/support-jobs/open     — browse all open support jobs
router.get(
  '/support-jobs/open',
  [
    query('page') .optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    validate,
  ],
  ctrl.getOpenSupportJobs,
);

// GET  /technician/support-jobs/mine     — my assigned / completed jobs
router.get(
  '/support-jobs/mine',
  [
    query('status').optional().isIn(['assigned', 'completed']),
    validate,
  ],
  ctrl.getMySupportJobs,
);

// POST /technician/support-jobs/:ticketId/grab    — self-assign
router.post(
  '/support-jobs/:ticketId/grab',
  [
    param('ticketId').isInt({ min: 1 }).withMessage('ticketId must be a positive integer'),
    validate,
  ],
  ctrl.grabSupportJob,
);

// PATCH /technician/support-jobs/:ticketId/resolve  — mark job done
router.patch(
  '/support-jobs/:ticketId/resolve',
  [
    param('ticketId').isInt({ min: 1 }).withMessage('ticketId must be a positive integer'),
    body('resolution_note').optional().isString().isLength({ max: 500 }),
    validate,
  ],
  ctrl.resolveSupportJob,
);

module.exports = router;