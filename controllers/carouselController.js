const carouselService = require('../services/carouselService');
const R = require('../utils/response');

// GET /api/v1/carousels
async function getCarousels(req, res, next) {
  try {
    const carousels = await carouselService.getActiveCarousels();

    const toB64 = (val) => {
      if (!val) return null;
      if (Buffer.isBuffer(val))    return val.toString('base64');
      if (val && val.data)         return Buffer.from(val.data).toString('base64');
      if (typeof val === 'string') return val;
      return null;
    };

    const formattedCarousels = carousels.map(c => ({
      id:          c.id,
      title:       c.title    || '',
      subtitle:    c.subtitle || '',
      image_url:   `data:${c.image_mime};base64,${toB64(c.image_data)}`,
      description: c.description || '',
      click_url:   c.click_url   || null,
      click_count: Number(c.click_count) || 0,
    }));

    return R.ok(res, { carousels: formattedCarousels });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/carousels  (admin)
async function createCarousel(req, res, next) {
  try {
    const {
      title, subtitle, image_data, image_mime,
      description, order, click_url,
    } = req.body;

    const carousel = await carouselService.createCarousel(req.admin?.id || req.user?.id, {
      title, subtitle, image_data, image_mime,
      description, order, click_url,
    });

    return R.created(res, carousel, 'Carousel image added successfully');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    next(err);
  }
}

// POST /api/v1/carousels/:id/click  (public — called by Flutter on tap)
async function trackClick(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid banner ID.');

    await carouselService.trackClick(id);
    return R.ok(res, null, 'Click recorded');
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/carousels/stats  (admin)
async function getAdStats(req, res, next) {
  try {
    const stats = await carouselService.getAdStats();
    return R.ok(res, stats);
  } catch (err) {
    next(err);
  }
}

module.exports = { getCarousels, createCarousel, trackClick, getAdStats };