const router           = require('express').Router();
const { authenticate } = require('../middleware/auth');
const ctrl             = require('../controllers/installationController');
 
router.use(authenticate);
 
router.post('/',        ctrl.createRequest);        // POST  /installations
router.get('/status',   ctrl.getInstallationStatus); // GET   /installations/status  
router.get('/active',   ctrl.getActiveRequest);      // GET   /installations/active
router.get('/:id',      ctrl.getRequest);            // GET   /installations/:id
 
module.exports = router;