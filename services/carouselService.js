const { db } = require('../config/db');

async function getActiveCarousels() {
  return db
    .selectFrom('dbo.carousel_banners')
    .select(['id', 'title', 'subtitle', 'image_data', 'image_mime', 'description', 'order'])
    .where('is_active', '=', true)
    .orderBy('order', 'asc')
    .execute();
}

async function createCarousel(userId, { title, subtitle, image_data, image_mime, description, order }) {
  // Validate base64 (like KYC validation)
  const MAX_BASE64_CHARS = 7_500_000; // ~5MB
  
  if (!image_data || image_data.length === 0) {
    throw Object.assign(new Error('image_data is required'), { statusCode: 400 });
  }

  if (image_data.length > MAX_BASE64_CHARS) {
    throw Object.assign(new Error('Image is too large (max 5MB)'), { statusCode: 400 });
  }

  const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!ALLOWED_MIMES.includes(image_mime)) {
    throw Object.assign(
      new Error(`Unsupported image type. Allowed: ${ALLOWED_MIMES.join(', ')}`),
      { statusCode: 400 }
    );
  }

  return db
    .insertInto('dbo.carousel_banners')
    .values({
      title: title || null,
      subtitle: subtitle || null,
      image_data,
      image_mime,
      description: description || null,
      order: order || 0,
      is_active: true,
    })
    .output(['inserted.id', 'inserted.title', 'inserted.image_mime'])
    .executeTakeFirstOrThrow();
}

module.exports = { getActiveCarousels, createCarousel };