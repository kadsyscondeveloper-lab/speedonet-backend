// controllers/contactController.js
const { db, sql } = require('../config/db');
const R           = require('../utils/response');
const logger      = require('../utils/logger');

// ── POST /api/v1/contact  (PUBLIC — no auth required) ────────────────────────
// Called from the "Contact Support" form on the login screen.
async function submitContactInquiry(req, res, next) {
  try {
    const { name, phone, email, subject, message } = req.body;

    if (!name?.trim() || !message?.trim())
      return R.badRequest(res, 'name and message are required.');

    if (!phone?.trim() && !email?.trim())
      return R.badRequest(res, 'Please provide either a phone number or email address.');

    if (phone?.trim() && !/^[6-9]\d{9}$/.test(phone.trim()))
      return R.badRequest(res, 'Enter a valid 10-digit Indian mobile number.');

    const row = await db
      .insertInto('dbo.contact_inquiries')
      .values({
        name:    name.trim(),
        phone:   phone?.trim()   || null,
        email:   email?.trim()   || null,
        subject: subject?.trim() || null,
        message: message.trim(),
      })
      .output(['inserted.id', 'inserted.reference_id'])
      .executeTakeFirstOrThrow();

    logger.info(`[Contact] New inquiry submitted: ${row.reference_id}`);

    return R.created(res,
      { reference_id: row.reference_id },
      "Thanks for reaching out! Our support team will contact you within 24 hours."
    );
  } catch (err) { next(err); }
}

// ── GET /api/v1/admin/contact-inquiries  (Admin) ──────────────────────────────
async function getContactInquiries(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT *
        FROM dbo.contact_inquiries
        ${status ? sql`WHERE status = ${status}` : sql``}
        ORDER BY created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.contact_inquiries WHERE status = ${status}`
            .execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.contact_inquiries')
            .select(db.fn.count('id').as('total'))
            .executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { inquiries: rows }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

// ── PATCH /api/v1/admin/contact-inquiries/:id  (Admin) ────────────────────────
async function updateContactInquiry(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid inquiry ID.');

    const { status, admin_notes } = req.body;
    const VALID = ['open', 'in_progress', 'resolved', 'closed'];
    if (!VALID.includes(status))
      return R.badRequest(res, `status must be one of: ${VALID.join(', ')}`);

    const inquiry = await db
      .selectFrom('dbo.contact_inquiries')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();

    if (!inquiry) return R.notFound(res, 'Inquiry not found.');

    await db
      .updateTable('dbo.contact_inquiries')
      .set({
        status,
        admin_notes:   admin_notes?.trim() || null,
        resolved_at:   ['resolved', 'closed'].includes(status) ? new Date() : null,
        updated_at:    sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', id)
      .execute();

    logger.info(`[Admin] Contact inquiry ${id} → ${status}`);
    return R.ok(res, null, `Inquiry marked as '${status}'.`);
  } catch (err) { next(err); }
}

module.exports = { submitContactInquiry, getContactInquiries, updateContactInquiry };