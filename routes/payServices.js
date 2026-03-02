// routes/payServices.js
// Public GET — used by Flutter app to load pay screen services dynamically.
// Admin CRUD is handled inside routes/admin.js (protected by authenticateAdmin).

const router = require('express').Router();
const ctrl   = require('../controllers/payServicesController');

// GET /api/v1/pay/services
router.get('/services', ctrl.getServices);

module.exports = router;