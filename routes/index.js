// routes/index.js
const router = require('express').Router();

router.use('/auth',       require('./auth'));
router.use('/user',       require('./user'));
router.use('/plans',      require('./plans'));
router.use('/wallet',     require('./wallet'));
router.use('/tickets',    require('./tickets'));
router.use('/payments',   require('./payments'));
router.use('/carousels',  require('./carousels'));
router.use('/pay',        require('./payServices'));
router.use('/fcm',        require('./fcm'));         
router.use('/admin/auth', require('./adminAuth'));
router.use('/admin',      require('./admin'));
router.use('/locations',  require('./locations'));
router.use('/availability',   require('./availability'));
router.use('/installations',  require('./installations'));
router.use('/technician/auth', require('./technicianAuth')); 
router.use('/technician',      require('./technician')); 

// Health check
router.get('/health', (req, res) => {
  res.json({
    success:   true,
    service:   'Speedonet API',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;