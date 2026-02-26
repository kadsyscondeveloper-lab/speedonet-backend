// routes/carousels.js
const router = require('express').Router();
const carouselService = require('../services/carouselService');
const R = require('../utils/response');

// GET all active carousels
async function getCarousels(req, res, next) {
  try {
    const carousels = await carouselService.getActiveCarousels();
    
    const formattedCarousels = carousels.map(c => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      image_url: `data:${c.image_mime};base64,${c.image_data}`,
      description: c.description,
    }));
    
    return R.ok(res, { carousels: formattedCarousels });
  } catch (err) {
    next(err);
  }
}

// POST create carousel (no auth for testing)
async function createCarousel(req, res, next) {
  try {
    const { title, subtitle, image_data, image_mime, description, order } = req.body;

    const carousel = await carouselService.createCarousel(null, {  // ← Pass null instead of req.user.id
      title,
      subtitle,
      image_data,
      image_mime,
      description,
      order,
    });

    return R.created(res, carousel, 'Carousel image added successfully');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  await db.deleteFrom('dbo.carousel_banners').where('id','=',parseInt(req.params.id)).execute();
  return R.ok(res, null, 'Banner deleted');
});

router.get('/', getCarousels);
router.post('/', createCarousel);

module.exports = router;