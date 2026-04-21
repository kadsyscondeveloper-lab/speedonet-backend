// routes/carousels.js
const router              = require('express').Router();
const { db }              = require('../config/db');
const { authenticateAdmin } = require('../middleware/adminAuth');
const carouselService     = require('../services/carouselService');
const ctrl                = require('../controllers/carouselController');
const R                   = require('../utils/response');

// =============================================================================
// GET /api/v1/carousels  — public, used by Flutter app
// =============================================================================
router.get('/', async (req, res, next) => {
  try {
    const rows = await db
      .selectFrom('dbo.carousel_banners')
      .select(['id', 'title', 'subtitle', 'description',
               'image_data', 'image_mime', 'order', 'is_active',
               'click_url', 'click_count'])
      .where('is_active', '=', true)
      .orderBy('order', 'asc')
      .execute();

    const toB64 = (val) => {
      if (!val) return null;
      if (Buffer.isBuffer(val))    return val.toString('base64');
      if (val && val.data)         return Buffer.from(val.data).toString('base64');
      if (typeof val === 'string') return val;
      return null;
    };

    const carousels = rows
      .map(c => {
        const b64 = toB64(c.image_data);
        return {
          id:          c.id,
          title:       c.title       || '',
          subtitle:    c.subtitle    || '',
          description: c.description || '',
          image_url:   b64 ? `data:${c.image_mime || 'image/jpeg'};base64,${b64}` : null,
          click_url:   c.click_url   || null,
          click_count: Number(c.click_count) || 0,
        };
      })
      .filter(c => c.image_url);

    return R.ok(res, { carousels });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /api/v1/carousels/:id/click  — public, called by Flutter on ad tap
// =============================================================================
router.post('/:id/click', ctrl.trackClick);

// =============================================================================
// GET /api/v1/carousels/stats  — admin only
// =============================================================================
router.get('/stats', authenticateAdmin, ctrl.getAdStats);

// =============================================================================
// POST /api/v1/carousels  — admin only, upload a new banner
// =============================================================================
router.post('/', authenticateAdmin, async (req, res, next) => {
  try {
    const {
      title, subtitle, image_data, image_mime,
      description, order, click_url,
    } = req.body;

    const carousel = await carouselService.createCarousel(req.admin.id, {
      title, subtitle, image_data, image_mime,
      description, order, click_url,
    });

    return R.created(res, carousel, 'Carousel banner added successfully');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
});

module.exports = router;