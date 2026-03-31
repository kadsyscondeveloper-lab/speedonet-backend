const { db, sql } = require('../config/db');
const R            = require('../utils/response');
const notifyUser   = require('../utils/notifyUser');

// POST /api/v1/availability/inquiry
async function submitInquiry(req, res, next) {
  try {
    const { name, phone, pin_code, address, email } = req.body;

    if (!name?.trim() || !phone?.trim() || !pin_code?.trim())
      return R.badRequest(res, 'name, phone, and pin_code are required.');

    if (!/^[6-9]\d{9}$/.test(phone.trim()))
      return R.badRequest(res, 'Enter a valid 10-digit Indian mobile number.');

    if (!/^\d{6}$/.test(pin_code.trim()))
      return R.badRequest(res, 'Enter a valid 6-digit PIN code.');

    // Prevent duplicate pending inquiry for same phone
    const existing = await db
      .selectFrom('dbo.availability_inquiries')
      .select('id')
      .where('phone',  '=', phone.trim())
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if (existing)
      return R.conflict(res,
        'You already have a pending inquiry. Our team will contact you shortly.');

    const row = await db
      .insertInto('dbo.availability_inquiries')
      .values({
        name:     name.trim(),
        phone:    phone.trim(),
        pin_code: pin_code.trim(),
        address:  address?.trim() || null,
        email:    email?.trim()   || null,
      })
      .output(['inserted.id', 'inserted.reference_id'])
      .executeTakeFirstOrThrow();

    return R.created(res,
      { reference_id: row.reference_id },
      "Thanks! Our team will check availability and contact you within 24 hours."
    );
  } catch (err) { next(err); }
}

// GET /api/v1/availability/status?phone=XXXXXXXXXX
// Lets the app poll inquiry status by phone number
async function getInquiryStatus(req, res, next) {
  try {
    const { phone } = req.query;
    if (!phone?.trim()) return R.badRequest(res, 'phone is required.');

    const inquiry = await db
      .selectFrom('dbo.availability_inquiries')
      .select(['reference_id', 'status', 'admin_notes', 'pin_code', 'responded_at', 'created_at'])
      .where('phone', '=', phone.trim())
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    if (!inquiry)
      return R.notFound(res, 'No inquiry found for this number.');

    return R.ok(res, { inquiry });
  } catch (err) { next(err); }
}

module.exports = { submitInquiry, getInquiryStatus };