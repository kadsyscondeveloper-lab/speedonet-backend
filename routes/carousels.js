const carouselService = require('../services/carouselService');
const R = require('../utils/response');

async function getCarousels(req, res, next) {
  try {
    const carousels = await carouselService.getActiveCarousels();
    
    // Format for Flutter: data:mime;base64,xxxxx
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

async function createCarousel(req, res, next) {
  try {
    const { title, subtitle, image_data, image_mime, description, order } = req.body;

    const carousel = await carouselService.createCarousel(req.user.id, {
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

module.exports = { getCarousels, createCarousel };