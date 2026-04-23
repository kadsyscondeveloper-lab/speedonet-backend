// controllers/videoKycController.js  (UPDATED — only new/changed functions shown below;
// keep all existing exports and add the two new ones at the bottom)

const { db, sql } = require('../config/db');
const R           = require('../utils/response');
const notifyUser  = require('../utils/notifyUser');
const logger      = require('../utils/logger');

// npm i agora-access-token
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const VALID_SLOTS = ['morning', 'afternoon', 'evening'];
const SLOT_LABELS = {
  morning:   '9:00 AM – 12:00 PM',
  afternoon: '12:00 PM – 4:00 PM',
  evening:   '4:00 PM – 7:00 PM',
};

// ── Agora helpers ─────────────────────────────────────────────────────────────

function _buildAgoraToken(channelName, uid) {
  const appId      = process.env.AGORA_APP_ID;
  const appCert    = process.env.AGORA_APP_CERTIFICATE;
  if (!appId || !appCert) throw new Error('Agora credentials not configured.');

  // Token valid for 2 hours
  const expireTs = Math.floor(Date.now() / 1000) + 7200;
  return RtcTokenBuilder.buildTokenWithUid(
    appId, appCert, channelName, uid, RtcRole.PUBLISHER, expireTs
  );
}

function _randomUid() {
  // Agora UIDs are 32-bit unsigned ints
  return Math.floor(Math.random() * 2_000_000) + 1;
}

// ── EXISTING FUNCTIONS (unchanged) ───────────────────────────────────────────

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
        // NEW fields
        'call_channel', 'call_uid_user', 'call_token_user', 'call_started_at',
      ])
      .where('user_id', '=', BigInt(req.user.id))
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    return R.ok(res, { video_kyc: row ?? null });
  } catch (err) { next(err); }
}

async function scheduleVideoKyc(req, res, next) {
  try {
    const { preferred_date, preferred_slot, call_phone } = req.body;

    if (!preferred_date || !preferred_slot || !call_phone?.trim())
      return R.badRequest(res, 'preferred_date, preferred_slot and call_phone are required.');

    if (!VALID_SLOTS.includes(preferred_slot))
      return R.badRequest(res, `preferred_slot must be one of: ${VALID_SLOTS.join(', ')}`);

    if (!/^[6-9]\d{9}$/.test(call_phone.trim()))
      return R.badRequest(res, 'Enter a valid 10-digit Indian mobile number.');

    const date = new Date(preferred_date);
    if (isNaN(date.getTime()))
      return R.badRequest(res, 'Invalid preferred_date. Use YYYY-MM-DD format.');

    const today   = new Date(); today.setHours(0, 0, 0, 0);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + 30);
    if (date < today)   return R.badRequest(res, 'Preferred date must be today or in the future.');
    if (date > maxDate) return R.badRequest(res, 'Preferred date must be within 30 days.');

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
        'You already have a video KYC call scheduled. Cancel before scheduling a new one.');
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
      body:  `Your video KYC call is scheduled for ${preferred_date} (${SLOT_LABELS[preferred_slot]}). We'll start the call from the app.`,
      data:  { reference_id: row.reference_id },
    });

    logger.info(`[VideoKYC] Scheduled: user=${req.user.id} ref=${row.reference_id}`);
    return R.created(res, { video_kyc: row },
      `Video KYC scheduled for ${preferred_date} (${SLOT_LABELS[preferred_slot]}).`);
  } catch (err) { next(err); }
}

async function cancelVideoKyc(req, res, next) {
  try {
    const row = await db
      .selectFrom('dbo.video_kyc_requests')
      .select(['id', 'status'])
      .where('user_id', '=', BigInt(req.user.id))
      .where('status', 'in', ['scheduled', 'confirmed', 'call_ready'])
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

// ── NEW: Admin starts the live call ──────────────────────────────────────────
//
// POST /admin/kyc/video/:id/start-call
//
// 1. Creates a unique Agora channel for this request
// 2. Mints RTC tokens for both the user and the admin
// 3. Saves everything in the DB + marks status = 'call_ready'
// 4. Sends a push notification to the user so they can tap "Join"
//
async function adminStartVideoCall(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid ID.');

    const request = await db
      .selectFrom('dbo.video_kyc_requests')
      .select(['id', 'user_id', 'status', 'reference_id'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!request) return R.notFound(res, 'Video KYC request not found.');

    const allowedStatuses = ['scheduled', 'confirmed', 'call_ready'];

    if (!allowedStatuses.includes(request.status))
      return R.badRequest(res,
        `Cannot start a call for a request with status '${request.status}'.`);

    // Generate channel + UIDs + tokens
    const channel      = `vkyc_${request.reference_id}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const uidUser      = _randomUid();
    const uidAdmin     = _randomUid();
    const tokenUser    = _buildAgoraToken(channel, uidUser);
    const tokenAdmin   = _buildAgoraToken(channel, uidAdmin);

    await db
      .updateTable('dbo.video_kyc_requests')
      .set({
        status:           'call_ready',
        call_channel:     channel,
        call_uid_user:    uidUser,
        call_uid_admin:   uidAdmin,
        call_token_user:  tokenUser,
        call_token_admin: tokenAdmin,
        call_started_at:  new Date(),
        confirmed_at:     new Date(),
        reviewed_by:      req.admin.id,
        updated_at:       sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', id)
      .execute();

    // Deep-link notification — user taps this to open the call screen
    await notifyUser(db, Number(request.user_id), {
      type:  'kyc',
      title: '📹 Your Video KYC Call is Starting!',
      body:  'An agent is ready. Open the app and tap "Join Call" now.',
      data:  {
        action:      'video_kyc_call',
        screen:      'video_kyc',
        call_ready:  'true',
      },
    });

    logger.info(`[VideoKYC] Call started: request=${id} channel=${channel} admin=${req.admin.id}`);

    return R.ok(res, {
      channel,
      agora_app_id: process.env.AGORA_APP_ID,
      uid:          uidAdmin,
      token:        tokenAdmin,
    }, 'Call started. User has been notified.');
  } catch (err) { next(err); }
}

// ── NEW: User fetches their call token ────────────────────────────────────────
//
// GET /user/kyc/video/call-token
//
// Called by the Flutter app when the user taps "Join Call".
// Returns the channel + token only if the request is in 'call_ready' state.
//
async function getUserCallToken(req, res, next) {
  try {
    const row = await db
      .selectFrom('dbo.video_kyc_requests')
      .select([
        'id', 'status', 'reference_id',
        'call_channel', 'call_uid_user', 'call_token_user',
      ])
      .where('user_id', '=', BigInt(req.user.id))
      .where('status', '=', 'call_ready')
      .orderBy('created_at', 'desc')
      .top(1)
      .executeTakeFirst();

    if (!row) return R.notFound(res, 'No active call found. The agent may not have started yet.');

    return R.ok(res, {
      channel:      row.call_channel,
      agora_app_id: process.env.AGORA_APP_ID,
      uid:          row.call_uid_user,
      token:        row.call_token_user,
      request_id:   row.id,
    });
  } catch (err) { next(err); }
}

// ── Existing admin list + update functions (unchanged) ────────────────────────

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
          vk.created_at, vk.call_started_at,
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

    const updates = { status, updated_at: sql`SYSUTCDATETIME()` };
    if (agent_notes)      updates.agent_notes      = agent_notes.trim();
    if (rejection_reason) updates.rejection_reason = rejection_reason.trim();
    if (status === 'confirmed') {
      updates.confirmed_at = new Date();
      if (confirmed_slot) updates.confirmed_slot = new Date(confirmed_slot);
    }
    if (status === 'completed') {
      updates.completed_at  = new Date();
      updates.call_ended_at = new Date();
    }
    if (['confirmed', 'completed'].includes(status))
      updates.reviewed_by = req.admin.id;

    await db.updateTable('dbo.video_kyc_requests').set(updates).where('id', '=', id).execute();

    const notifMap = {
      confirmed: {
        title: 'Video KYC Confirmed 📅',
        body:  confirmed_slot
          ? `Your video KYC call is confirmed for ${new Date(confirmed_slot).toLocaleString('en-IN')}.`
          : 'Your video KYC slot is confirmed. Our agent will start the call from the app.',
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
  adminStartVideoCall,   // NEW
  getUserCallToken,      // NEW
};