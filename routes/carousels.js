// routes/carousels.js
// Public GET (used by the Flutter app) and POST (for uploading banners).
// DELETE is handled by /admin/carousel/:id in routes/admin.js.

const router          = require('express').Router();
const carouselService = require('../services/carouselService');
const { authenticateAdmin } = require('../middleware/adminAuth');
const R = require('../utils/response');

// =============================================================================
// GET /api/v1/carousels  — public, used by Flutter app
// =============================================================================
router.get('/', async (req, res, next) => {
  try {
    const { db } = require('../config/db');

    // Query directly to guarantee image_data is included.
    // carouselService.getActiveCarousels() may omit the binary column.
    const rows = await db
      .selectFrom('dbo.carousel_banners')
      .select(['id', 'title', 'subtitle', 'description',
               'image_data', 'image_mime', 'order', 'is_active'])
      .where('is_active', '=', true)
      .orderBy('order', 'asc')
      .execute();

    // SQL Server returns binary/varbinary columns as Buffer objects.
    // Convert to base64 so Flutter can render a data: URI.
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
        };
      })
      .filter(c => c.image_url);  // drop rows with no valid image

    return R.ok(res, { carousels });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /api/v1/carousels  — admin only, upload a new banner
// =============================================================================
router.post('/', authenticateAdmin, async (req, res, next) => {
  try {
    const { title, subtitle, image_data, image_mime, description, order } = req.body;

    const carousel = await carouselService.createCarousel(req.admin.id, {
      title, subtitle, image_data, image_mime, description, order,
    });

    return R.created(res, carousel, 'Carousel banner added successfully');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
});

module.exports = router;