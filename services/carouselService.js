const { db, sql } = require('../config/db');

async function getActiveCarousels() {
  return db
    .selectFrom('dbo.carousel_banners')
    .select(['id', 'title', 'subtitle', 'image_data', 'image_mime',
             'description', 'order', 'click_url', 'click_count'])
    .where('is_active', '=', true)
    .orderBy('order', 'asc')
    .execute();
}

async function createCarousel(userId, {
  title, subtitle, image_data, image_mime, description, order, click_url,
}) {
  const MAX_BASE64_CHARS = 7_500_000;

  if (!image_data || image_data.length === 0)
    throw Object.assign(new Error('image_data is required'), { statusCode: 400 });

  if (image_data.length > MAX_BASE64_CHARS)
    throw Object.assign(new Error('Image is too large (max 5MB)'), { statusCode: 400 });

  const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!ALLOWED_MIMES.includes(image_mime))
    throw Object.assign(
      new Error(`Unsupported image type. Allowed: ${ALLOWED_MIMES.join(', ')}`),
      { statusCode: 400 }
    );

  // Validate click_url if provided
  if (click_url && click_url.trim()) {
    try {
      const u = new URL(click_url.trim());
      if (!['http:', 'https:'].includes(u.protocol))
        throw new Error();
    } catch {
      throw Object.assign(
        new Error('click_url must be a valid https URL'),
        { statusCode: 400 }
      );
    }
  }

  return db
    .insertInto('dbo.carousel_banners')
    .values({
      title:       title       || null,
      subtitle:    subtitle    || null,
      image_data,
      image_mime,
      description: description || null,
      order:       order       || 0,
      is_active:   true,
      click_url:   click_url?.trim() || null,
      click_count: 0,
    })
    .output(['inserted.id', 'inserted.title', 'inserted.image_mime', 'inserted.click_url'])
    .executeTakeFirstOrThrow();
}

/**
 * Increment click counter for a carousel banner.
 * Called by the Flutter app when a user taps the ad.
 */
async function trackClick(bannerId) {
  await db
    .updateTable('dbo.carousel_banners')
    .set({ click_count: sql`ISNULL(click_count, 0) + 1` })
    .where('id',        '=', bannerId)
    .where('is_active', '=', true)
    .execute();
}

/**
 * Returns per-banner click stats for the admin dashboard.
 */
async function getAdStats() {
  const rows = await db
    .selectFrom('dbo.carousel_banners')
    .select(['id', 'title', 'subtitle', 'order', 'is_active',
             'click_url', 'click_count', 'created_at'])
    .orderBy('click_count', 'desc')
    .execute();

  const total = rows.reduce((s, r) => s + (Number(r.click_count) || 0), 0);
  const active = rows.filter(r => r.is_active).length;

  return {
    banners:      rows,
    total_clicks: total,
    active_count: active,
    total_count:  rows.length,
  };
}

module.exports = { getActiveCarousels, createCarousel, trackClick, getAdStats };