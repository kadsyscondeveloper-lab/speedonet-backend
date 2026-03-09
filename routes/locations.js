// routes/locations.js
const router = require('express').Router();
const ctrl   = require('../controllers/locationController');
const { authenticateAdmin } = require('../middleware/adminAuth');

// ── Public (Flutter app) ──────────────────────────────────────────
router.get('/states',              ctrl.getStates);
router.get('/cities',              ctrl.getCities);  // ?state=Maharashtra

// ── Admin CRUD ────────────────────────────────────────────────────
router.get   ('/admin/states',                     authenticateAdmin, ctrl.adminGetStates);
router.post  ('/admin/states',                     authenticateAdmin, ctrl.adminAddState);
router.patch ('/admin/states/:stateId',            authenticateAdmin, ctrl.adminUpdateState);
router.delete('/admin/states/:stateId',            authenticateAdmin, ctrl.adminDeleteState);

router.get   ('/admin/states/:stateId/cities',     authenticateAdmin, ctrl.adminGetCities);
router.post  ('/admin/states/:stateId/cities',     authenticateAdmin, ctrl.adminAddCity);
router.patch ('/admin/cities/:cityId',             authenticateAdmin, ctrl.adminUpdateCity);
router.delete('/admin/cities/:cityId',             authenticateAdmin, ctrl.adminDeleteCity);

module.exports = router;