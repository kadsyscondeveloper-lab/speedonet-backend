// services/videoKycService.js
//
// Handles all DB operations for the self-upload Video KYC flow.
// Videos are stored on disk via multer; only the relative path is saved in DB.

const path     = require('path');
const { db, sql } = require('../config/db');
const notifyUser  = require('../utils/notifyUser');
const logger      = require('../utils/logger');
const crypto      = require('crypto');

const { analyzeVideoKyc }  = require('./videoKycAiService');
const { resolveVideoPath } = require('../middleware/videoUpload');
// ── Reference ID generator ────────────────────────────────────────────────────

function generateReferenceId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `VKYC-${date}-${rand}`;
}

// ── Get current Video KYC request for a user ──────────────────────────────────

async function getVideoKycStatus(userId) {
  const row = await db
    .selectFrom('dbo.video_kyc_requests')
    .select([
      'id', 'reference_id', 'status',
      'video_path', 'video_mime', 'video_size_bytes',
      'rejection_reason', 'agent_notes',
      'reviewed_by', 'reviewed_at',
      'created_at', 'updated_at',
    ])
    .where('user_id', '=', BigInt(userId))
    .orderBy('created_at', 'desc')
    .top(1)
    .executeTakeFirst();

  return row ?? null;
}

// ── Submit a new video ────────────────────────────────────────────────────────
//
// Called after multer has already saved the file to disk.
// `file` is the req.file object from multer.

async function submitVideoKyc(userId, file) {
  // Block if there's already a non-terminal request
  const existing = await db
    .selectFrom('dbo.video_kyc_requests')
    .select(['id', 'status'])
    .where('user_id', '=', BigInt(userId))
    .where('status', 'not in', ['cancelled', 'failed', 'rejected'])
    .top(1)
    .executeTakeFirst();

  if (existing) {
    if (existing.status === 'completed') {
      throw Object.assign(
        new Error('Your Video KYC has already been completed.'),
        { statusCode: 409 }
      );
    }
    throw Object.assign(
      new Error('You already have a pending Video KYC submission. Cancel it before submitting a new one.'),
      { statusCode: 409 }
    );
  }

  const referenceId = generateReferenceId();

  const relativePath = path.relative(process.cwd(), file.path);

  const row = await db
    .insertInto('dbo.video_kyc_requests')
    .values({
      user_id:          BigInt(userId),
      reference_id:     referenceId,
      status:           'pending',
      video_path:       relativePath,
      video_mime:       file.mimetype,
      video_size_bytes: file.size,
    })
    .output([
      'inserted.id',
      'inserted.reference_id',
      'inserted.status',
      'inserted.created_at',
    ])
    .executeTakeFirstOrThrow();

  await notifyUser(db, userId, {
    type:  'kyc',
    title: 'Video KYC Submitted 📹',
    body:  `Your video (ref: ${referenceId}) has been received and is under review. We'll notify you once complete.`,
    data:  { reference_id: referenceId },
  });

  logger.info(`[VideoKYC] Submitted: user=${userId} ref=${referenceId} size=${file.size}B`);

  // ── AI verification ───────────────────────────────────────────────────────
  // Runs in background via setImmediate so the user gets an instant 201 response.
  // The AI takes 5–30 seconds depending on video length and server CPU.
  // If AI crashes for any reason the submission stays 'pending' for manual review.

  setImmediate(async () => {
    try {
      const absPath = resolveVideoPath(relativePath);
      const ai      = await analyzeVideoKyc(absPath);

      logger.info(`[VideoKYC] AI decision for ref=${referenceId}: ${ai.decision} (score=${ai.score})`);

      // Re-check status — an admin might have already acted while AI was running
      const current = await db
        .selectFrom('dbo.video_kyc_requests')
        .select(['status'])
        .where('reference_id', '=', referenceId)
        .executeTakeFirst();

      if (!current || current.status !== 'pending') {
        logger.info(`[VideoKYC] AI skipping update — status already changed to '${current?.status}' for ref=${referenceId}`);
        return;
      }

      // Build the update payload
      const updates = {
        status:      ai.decision,
        agent_notes: ai.agent_notes,
        updated_at:  sql`SYSUTCDATETIME()`,
      };

      if (ai.rejection_reason) {
        updates.rejection_reason = ai.rejection_reason;
      }

      if (['completed', 'rejected', 'failed'].includes(ai.decision)) {
        updates.reviewed_at = new Date();
      }

      await db
        .updateTable('dbo.video_kyc_requests')
        .set(updates)
        .where('reference_id', '=', referenceId)
        .execute();

      // Notify user of the AI decision
      const notifMap = {
        completed: {
          title: 'Video KYC Approved ✅',
          body:  'Your Video KYC was automatically verified and is now complete!',
        },
        rejected: {
          title: 'Video KYC Rejected ❌',
          body:  ai.rejection_reason || 'Please re-record your video and try again.',
        },
        under_review: {
          title: 'Video KYC Under Review 🔍',
          body:  'Your video is being reviewed by our team. We\'ll notify you soon.',
        },
      };

      const notif = notifMap[ai.decision];
      if (notif) {
        await notifyUser(db, userId, {
          type:  'kyc',
          title: notif.title,
          body:  notif.body,
          data:  { video_kyc_status: ai.decision, reference_id: referenceId },
        });
      }

      logger.info(`[VideoKYC] AI update complete for ref=${referenceId} → ${ai.decision}`);

    } catch (aiErr) {
      // AI failure is non-fatal — submission stays as 'pending' for manual review
      logger.error(`[VideoKYC] AI verification error for ref=${referenceId}: ${aiErr.message}`);
    }
  });
  // ── End AI verification ───────────────────────────────────────────────────

  return row;
}

// ── Cancel a pending submission ───────────────────────────────────────────────

async function cancelVideoKyc(userId) {
  const row = await db
    .selectFrom('dbo.video_kyc_requests')
    .select(['id', 'status', 'video_path'])
    .where('user_id', '=', BigInt(userId))
    .where('status', 'in', ['pending', 'under_review'])
    .orderBy('created_at', 'desc')
    .top(1)
    .executeTakeFirst();

  if (!row) {
    throw Object.assign(
      new Error('No cancellable Video KYC request found.'),
      { statusCode: 404 }
    );
  }

  await db
    .updateTable('dbo.video_kyc_requests')
    .set({ status: 'cancelled', updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', row.id)
    .execute();

  logger.info(`[VideoKYC] Cancelled: user=${userId} id=${row.id}`);

  // Return the video path so the controller can delete the file from disk
  return { id: row.id, videoPath: row.video_path };
}

// ── Admin: list all video KYC requests ────────────────────────────────────────

async function adminListRequests({ page = 1, limit = 15, status = '' } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    sql`
      SELECT
        vk.id, vk.reference_id, vk.status,
        vk.video_mime, vk.video_size_bytes,
        vk.rejection_reason, vk.agent_notes,
        vk.reviewed_at, vk.created_at,
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

  return { requests: rows, total: Number(countRow.total) };
}

// ── Admin: get single request with video path ─────────────────────────────────

async function adminGetRequest(id) {
  return db
    .selectFrom('dbo.video_kyc_requests as vk')
    .innerJoin('dbo.users as u', 'u.id', 'vk.user_id')
    .select([
      'vk.id', 'vk.reference_id', 'vk.status',
      'vk.video_path', 'vk.video_mime', 'vk.video_size_bytes',
      'vk.rejection_reason', 'vk.agent_notes',
      'vk.reviewed_by', 'vk.reviewed_at', 'vk.created_at',
      'u.id as user_id', 'u.name as user_name',
      'u.phone as user_phone', 'u.email as user_email',
    ])
    .where('vk.id', '=', id)
    .executeTakeFirst();
}

// ── Admin: update request status ─────────────────────────────────────────────

async function adminUpdateRequest(id, adminId, { status, agent_notes, rejection_reason }) {
  const VALID = ['under_review', 'completed', 'rejected', 'failed'];
  if (!VALID.includes(status)) {
    throw Object.assign(
      new Error(`status must be one of: ${VALID.join(', ')}`),
      { statusCode: 400 }
    );
  }

  if (['rejected', 'failed'].includes(status) && !rejection_reason) {
    throw Object.assign(
      new Error('rejection_reason is required when rejecting a submission.'),
      { statusCode: 400 }
    );
  }

  const request = await db
    .selectFrom('dbo.video_kyc_requests')
    .select(['id', 'user_id', 'status', 'reference_id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (!request) throw Object.assign(new Error('Video KYC request not found.'), { statusCode: 404 });
  if (request.status === 'completed') {
    throw Object.assign(new Error('This request is already completed.'), { statusCode: 400 });
  }

  const updates = { status, updated_at: sql`SYSUTCDATETIME()`, reviewed_by: adminId };
  if (agent_notes)      updates.agent_notes      = agent_notes.trim();
  if (rejection_reason) updates.rejection_reason = rejection_reason.trim();
  if (['completed', 'rejected', 'failed'].includes(status)) {
    updates.reviewed_at = new Date();
  }

  await db
    .updateTable('dbo.video_kyc_requests')
    .set(updates)
    .where('id', '=', id)
    .execute();

  // Push notifications
  const notifMap = {
    under_review: {
      title: 'Video KYC Under Review 🔍',
      body:  'Your video submission is being reviewed by our team. We\'ll notify you soon.',
    },
    completed: {
      title: 'Video KYC Approved ✅',
      body:  'Your Video KYC is complete! Your full KYC verification is now done.',
    },
    rejected: {
      title: 'Video KYC Rejected ❌',
      body:  rejection_reason
        ? `Your video could not be verified: ${rejection_reason}. Please submit a new video.`
        : 'Your video KYC was rejected. Please submit a new video.',
    },
    failed: {
      title: 'Video KYC Failed ❌',
      body:  rejection_reason || 'Video verification failed. Please try again.',
    },
  };

  const notif = notifMap[status];
  if (notif) {
    await notifyUser(db, Number(request.user_id), {
      type:  'kyc',
      title: notif.title,
      body:  notif.body,
      data:  { video_kyc_status: status, reference_id: request.reference_id },
    });
  }

  logger.info(`[VideoKYC] Admin ${adminId} → request ${id} → ${status}`);
  return { id, status };
}

module.exports = {
  getVideoKycStatus,
  submitVideoKyc,
  cancelVideoKyc,
  adminListRequests,
  adminGetRequest,
  adminUpdateRequest,
};