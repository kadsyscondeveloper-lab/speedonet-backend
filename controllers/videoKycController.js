// controllers/videoKycController.js
//
// Self-upload Video KYC — user records a video and uploads it directly.
// Agora live-call code has been removed entirely.
// Multer saves the file to disk; we store only the relative path in DB.

const path    = require('path');
const fs      = require('fs');
const R       = require('../utils/response');
const logger  = require('../utils/logger');
const svc     = require('../services/videoKycService');
const { deleteVideoFile, resolveVideoPath } = require('../middleware/videoUpload');

// ── User: GET /user/kyc/video ─────────────────────────────────────────────────

async function getVideoKycStatus(req, res, next) {
  try {
    const row = await svc.getVideoKycStatus(req.user.id);
    return R.ok(res, { video_kyc: row ?? null });
  } catch (err) { next(err); }
}

// ── User: POST /user/kyc/video ────────────────────────────────────────────────
//
// Expects multipart/form-data with a single field "video".
// Multer middleware (uploadVideoKyc) must run BEFORE this controller.

async function submitVideoKyc(req, res, next) {
  try {
    if (!req.file) {
      return R.badRequest(res, 'No video file received. Send the file in the "video" field.');
    }

    logger.info(
      `[VideoKYC] Upload received: user=${req.user.id} ` +
      `file=${req.file.originalname} size=${req.file.size}B mime=${req.file.mimetype}`
    );

    let row;
    try {
      row = await svc.submitVideoKyc(req.user.id, req.file);
    } catch (svcErr) {
      // If the DB insert fails, clean up the uploaded file immediately
      deleteVideoFile(req.file.path);
      throw svcErr;
    }

    return res.status(201).json({
      success: true,
      message: 'Video submitted successfully. We will review it shortly.',
      data:    row,
    });
  } catch (err) { next(err); }
}

// ── User: DELETE /user/kyc/video ──────────────────────────────────────────────

async function cancelVideoKyc(req, res, next) {
  try {
    const result = await svc.cancelVideoKyc(req.user.id);

    // Best-effort: delete the video file from disk
    if (result.videoPath) {
      deleteVideoFile(resolveVideoPath(result.videoPath));
    }

    return R.ok(res, null, 'Video KYC submission cancelled.');
  } catch (err) { next(err); }
}

// ── Admin: GET /admin/kyc/video ───────────────────────────────────────────────

async function adminGetVideoKycRequests(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.max(1, parseInt(req.query.limit || '15'));
    const status = req.query.status || '';

    const { requests, total } = await svc.adminListRequests({ page, limit, status });

    return R.ok(res, { requests }, 'OK', 200, {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    });
  } catch (err) { next(err); }
}

// ── Admin: GET /admin/kyc/video/:id ──────────────────────────────────────────
//
// Returns request details. Does NOT stream the video — use the video
// endpoint below for that.

async function adminGetVideoKycRequest(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid ID.');

    const request = await svc.adminGetRequest(id);
    if (!request) return R.notFound(res, 'Video KYC request not found.');

    // Expose a convenience URL the admin panel can use to stream the video
    const videoUrl = request.video_path
      ? `/api/v1/admin/kyc/video/${id}/stream`
      : null;

    return R.ok(res, { request: { ...request, video_url: videoUrl } });
  } catch (err) { next(err); }
}

// ── Admin: GET /admin/kyc/video/:id/stream ────────────────────────────────────
//
// Streams the stored video file directly to the admin browser.
// Supports HTTP Range requests so browsers can seek/scrub.

async function adminStreamVideo(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid ID.');

    const request = await svc.adminGetRequest(id);
    if (!request)          return R.notFound(res, 'Video KYC request not found.');
    if (!request.video_path) return R.notFound(res, 'No video file on record for this request.');

    const absPath = resolveVideoPath(request.video_path);

    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (_) {
      return R.notFound(res, 'Video file not found on server.');
    }

    const fileSize  = stat.size;
    const mimeType  = request.video_mime || 'video/mp4';
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      // Partial content — enables browser scrubbing
      const parts  = rangeHeader.replace(/bytes=/, '').split('-');
      const start  = parseInt(parts[0], 10);
      const end    = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mimeType,
      });

      fs.createReadStream(absPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   mimeType,
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(absPath).pipe(res);
    }
  } catch (err) { next(err); }
}

// ── Admin: PATCH /admin/kyc/video/:id ─────────────────────────────────────────

async function adminUpdateVideoKyc(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return R.badRequest(res, 'Invalid ID.');

    const { status, agent_notes, rejection_reason } = req.body;

    await svc.adminUpdateRequest(id, req.admin.id, {
      status,
      agent_notes,
      rejection_reason,
    });

    return R.ok(res, null, `Video KYC marked as '${status}'.`);
  } catch (err) { next(err); }
}

module.exports = {
  getVideoKycStatus,
  submitVideoKyc,
  cancelVideoKyc,
  adminGetVideoKycRequests,
  adminGetVideoKycRequest,
  adminStreamVideo,
  adminUpdateVideoKyc,
};