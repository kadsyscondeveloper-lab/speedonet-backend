// routes/rent.js

const router           = require('express').Router();
const { authenticate } = require('../middleware/auth');
const ctrl             = require('../controllers/rentController');

router.use(authenticate);

// GET  /api/v1/rent/status   — current pending rent, slot info, window status
router.get('/status', ctrl.getStatus);

// POST /api/v1/rent/collect  — claim pending rent into wallet
router.post('/collect', ctrl.collect);

module.exports = router;