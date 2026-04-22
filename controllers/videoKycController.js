// controllers/videoKycController.js
//
// Video KYC — user schedules a call slot; admin confirms, calls, then marks complete.
// All routes are in routes/user.js (user-facing) and routes/admin.js (admin-facing).

const { db, sql } = require('../config/db');
const R           = require('../utils/response');
const notifyUser  = require('../utils/notifyUser');
const logger      = require('../utils/logger');

const VALID_SLOTS = ['morning', 'afternoon', 'evening'];

const SLOT_LABELS = {
  morning:   '9:00 AM – 12:00 PM',
  afternoon: '12:00 PM – 4:00 PM',
  evening:   '4:00 PM – 7:00 PM',
};

// ── GET /user/kyc/video  ──────────────────────────────────────────────────────
// Returns the latest video KYC request for the logged-in user.
async function getVideoKycStatus(req, res, next) {
  try {
    const row = await db
      .selectFrom('dbo.video_kyc_requests')
      .select([
        'id', 'reference_id', 'status',
        'preferred_date', 'preferred_slot', 'call_phone',
        'confirmed_at', 'confirmed_slot',
        'completed_at', 'rejection_reason', 'agent_notes',
        'created_at',
      ])
      .where('user_id', '=', BigInt(req.user.id))
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    return R.ok(res, { video_kyc: row ?? null });
  } catch (err) { next(err); }
}

// ── POST /user/kyc/video  ─────────────────────────────────────────────────────
// Schedule a new video KYC call.
// Body: { preferred_date: "YYYY-MM-DD", preferred_slot: "morning"|..., call_phone: "10-digit" }
async function scheduleVideoKyc(req, res, next) {
  try {
    const { preferred_date, preferred_slot, call_phone } = req.body;

    // Validation
    if (!preferred_date || !preferred_slot || !call_phone?.trim())
      return R.badRequest(res, 'preferred_date, preferred_slot and call_phone are required.');

    if (!VALID_SLOTS.includes(preferred_slot))
      return R.badRequest(res, `preferred_slot must be one of: ${VALID_SLOTS.join(', ')}`);

    if (!/^[6-9]\d{9}$/.test(call_phone.trim()))
      return R.badRequest(res, 'Enter a valid 10-digit Indian mobile number.');

    const date = new Date(preferred_date);
    if (isNaN(date.getTime()))
      return R.badRequest(res, 'Invalid preferred_date. Use YYYY-MM-DD format.');

    // Must be a future date (within 30 days)
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const maxDate  = new Date(today); maxDate.setDate(maxDate.getDate() + 30);
    if (date < today)    return R.badRequest(res, 'Preferred date must be today or in the future.');
    if (date > maxDate)  return R.badRequest(res, 'Preferred date must be within 30 days.');

    // Block if a non-cancelled request already exists
    const existing = await db
      .selectFrom('dbo.video_kyc_requests')
      .select(['id', 'status'])
      .where('user_id', '=', BigInt(req.user.id))
      .where('status', 'not in', ['cancelled', 'failed'])
      .executeTakeFirst();

    if (existing) {
      if (existing.status === 'completed')
        return R.conflict(res, 'Your video KYC has already been completed.');
      return R.conflict(res,
        'You already have a video KYC call scheduled. ' +
        'Cancel the existing request before scheduling a new one.');
    }

    const row = await db
      .insertInto('dbo.video_kyc_requests')
      .values({
        user_id:        BigInt(req.user.id),
        preferred_date: new Date(preferred_date),
        preferred_slot,
        call_phone:     call_phone.trim(),
      })
      .output([
        'inserted.id', 'inserted.reference_id', 'inserted.status',
        'inserted.preferred_date', 'inserted.preferred_slot', 'inserted.call_phone',
        'inserted.created_at',
      ])
      .executeTakeFirstOrThrow();

    await notifyUser(db, req.user.id, {
      type:  'kyc',
      title: 'Video KYC Scheduled 📹',
      body:  `Your video KYC call is scheduled for ${preferred_date} (${SLOT_LABELS[preferred_slot]}). We'll call you at ${call_phone.trim()}.`,
      data:  { reference_id: row.reference_id },
    });

    logger.info(`[VideoKYC] Scheduled: user=${req.user.id} ref=${row.reference_id}`);
    return R.created(res, { video_kyc: row },
      `Video KYC scheduled for ${preferred_date} (${SLOT_LABELS[preferred_slot]}).`);
  } catch (err) { next(err); }
}

// ── DELETE /user/kyc/video  ───────────────────────────────────────────────────
// Cancel the latest scheduled/confirmed video KYC request.
async function cancelVideoKyc(req, res, next) {
  try {
    const row = await db
      .selectFrom('dbo.video_kyc_requests')
      .select(['id', 'status'])
      .where('user_id', '=', BigInt(req.user.id))
      .where('status', 'in', ['scheduled', 'confirmed'])
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    if (!row) return R.notFound(res, 'No cancellable video KYC request found.');

    await db
      .updateTable('dbo.video_kyc_requests')
      .set({ status: 'cancelled', updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', row.id)
      .execute();

    return R.ok(res, null, 'Video KYC request cancelled.');
  } catch (err) { next(err); }
}

// ── ADMIN: GET /admin/kyc/video  ──────────────────────────────────────────────
async function adminGetVideoKycRequests(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const status = req.query.status || '';
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      sql`
        SELECT
          vk.id, vk.reference_id, vk.status,
          vk.preferred_date, vk.preferred_slot, vk.call_phone,
          vk.confirmed_at, vk.confirmed_slot,
          vk.completed_at, vk.rejection_reason, vk.agent_notes,
          vk.created_at,
          u.name  AS user_name,
          u.phone AS user_phone,
          u.email AS user_email
        FROM dbo.video_kyc_requests vk
        INNER JOIN dbo.users u ON u.id = vk.user_id
        ${status ? sql`WHERE vk.status = ${status}` : sql``}
        ORDER BY vk.created_at DESC
        OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
      `.execute(db).then(r => r.rows),

      status
        ? sql`SELECT COUNT(id) AS total FROM dbo.video_kyc_requests WHERE status = ${status}`
            .execute(db).then(r => r.rows[0])
        : db.selectFrom('dbo.video_kyc_requests')
            .select(db.fn.count('id').as('total'))
            .executeTakeFirstOrThrow(),
    ]);

    const total = Number(countRow.total);
    return R.ok(res, { requests: rows }, 'OK', 200,
      { page, limit, total, total_pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

// ── ADMIN: PATCH /admin/kyc/video/:id  ───────────────────────────────────────
// Update video KYC status (confirmed → completed / failed / cancelled).
// Body: { status, agent_notes?, rejection_reason?, confirmed_slot? }
async function adminUpdateVideoKyc(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid ID.');

    const { status, agent_notes, rejection_reason, confirmed_slot } = req.body;
    const VALID = ['confirmed', 'completed', 'failed', 'cancelled'];
    if (!VALID.includes(status))
      return R.badRequest(res, `status must be one of: ${VALID.join(', ')}`);

    if (status === 'failed' && !rejection_reason)
      return R.badRequest(res, 'rejection_reason is required when marking as failed.');

    const request = await db
      .selectFrom('dbo.video_kyc_requests')
      .select(['id', 'user_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!request) return R.notFound(res, 'Video KYC request not found.');
    if (request.status === 'completed')
      return R.badRequest(res, 'This request is already completed.');

    const updates = {
      status,
      updated_at: sql`SYSUTCDATETIME()`,
    };
    if (agent_notes)      updates.agent_notes      = agent_notes.trim();
    if (rejection_reason) updates.rejection_reason = rejection_reason.trim();
    if (status === 'confirmed') {
      updates.confirmed_at   = new Date();
      if (confirmed_slot) updates.confirmed_slot = new Date(confirmed_slot);
    }
    if (status === 'completed') updates.completed_at = new Date();
    if (status === 'confirmed' || status === 'completed')
      updates.reviewed_by = req.admin.id;

    await db.updateTable('dbo.video_kyc_requests').set(updates).where('id', '=', id).execute();

    // Notify user
    const notifMap = {
      confirmed: {
        title: 'Video KYC Confirmed 📅',
        body:  confirmed_slot
          ? `Your video KYC call is confirmed for ${new Date(confirmed_slot).toLocaleString('en-IN')}. We'll call you then!`
          : 'Your video KYC slot is confirmed. Our agent will call you at the scheduled time.',
      },
      completed: {
        title: 'Video KYC Completed ✅',
        body:  'Your video KYC verification is complete. Your full KYC is now done!',
      },
      failed: {
        title: 'Video KYC Failed ❌',
        body:  rejection_reason
          ? `Your video KYC could not be completed: ${rejection_reason}. Please reschedule.`
          : 'Your video KYC could not be completed. Please reschedule a new slot.',
      },
    };

    const notif = notifMap[status];
    if (notif) {
      await notifyUser(db, Number(request.user_id), {
        type: 'kyc', title: notif.title, body: notif.body,
        data: { video_kyc_status: status },
      });
    }

    logger.info(`[VideoKYC] Admin ${req.admin.id} → request ${id} → ${status}`);
    return R.ok(res, null, `Video KYC marked as '${status}'.`);
  } catch (err) { next(err); }
}

module.exports = {
  getVideoKycStatus,
  scheduleVideoKyc,
  cancelVideoKyc,
  adminGetVideoKycRequests,
  adminUpdateVideoKyc,
};