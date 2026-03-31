const router = require('express').Router();
const ctrl   = require('../controllers/availabilityController');

// POST /api/v1/availability/inquiry
router.post('/inquiry', ctrl.submitInquiry);

// GET  /api/v1/availability/status?phone=XXXXXXXXXX
router.get('/status', ctrl.getInquiryStatus);

module.exports = router;