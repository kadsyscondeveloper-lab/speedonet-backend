// middleware/videoUpload.js
//
// Multer-based video upload middleware for Video KYC.
//
// Folder layout:
//   uploads/
//   └── video-kyc/
//       └── 2025/
//           └── 06/
//               └── vkyc_<userId>_<timestamp>.mp4
//
// Env vars:
//   VIDEO_UPLOAD_DIR  – root directory (default: uploads/video-kyc)
//   VIDEO_MAX_MB      – max file size in MB   (default: 50)

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

// ── Config ────────────────────────────────────────────────────────────────────

const UPLOAD_ROOT    = process.env.VIDEO_UPLOAD_DIR || 'uploads/video-kyc';
const MAX_MB         = parseInt(process.env.VIDEO_MAX_MB || '50');
const MAX_BYTES      = MAX_MB * 1024 * 1024;

const ALLOWED_MIMES  = new Set([
  'video/mp4',
  'video/quicktime',   // .mov
  'video/x-msvideo',  // .avi
  'video/webm',
  'video/mpeg',
  'video/3gpp',        // Android native recordings
  'video/x-matroska', // .mkv (some devices)
]);

const ALLOWED_EXTS   = new Set(['.mp4', '.mov', '.avi', '.webm', '.mpeg', '.3gp', '.mkv']);

// ── Ensure root upload directory exists at startup ─────────────────────────

try {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  logger.info(`[VideoUpload] Root directory ready: ${path.resolve(UPLOAD_ROOT)}`);
} catch (err) {
  logger.error(`[VideoUpload] Cannot create root directory: ${err.message}`);
}

// ── Disk storage ──────────────────────────────────────────────────────────────

const storage = multer.diskStorage({

  destination(req, file, cb) {
    // Organise by year/month to prevent one giant flat folder
    const now   = new Date();
    const year  = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dir   = path.join(UPLOAD_ROOT, String(year), month);

    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      logger.error(`[VideoUpload] mkdir failed: ${err.message}`);
      cb(err);
    }
  },

  filename(req, file, cb) {
    const userId    = req.user?.id ?? 'unknown';
    const timestamp = Date.now();
    const ext       = _safeExt(file.originalname, file.mimetype);
    const filename  = `vkyc_${userId}_${timestamp}${ext}`;
    cb(null, filename);
  },
});

// ── File filter ───────────────────────────────────────────────────────────────

function fileFilter(req, file, cb) {
  const ext     = path.extname(file.originalname).toLowerCase();
  const mimeOk  = ALLOWED_MIMES.has(file.mimetype);
  const extOk   = ALLOWED_EXTS.has(ext) || ext === '';   // ext may be absent on some mobile uploads

  if (mimeOk || extOk) {
    return cb(null, true);
  }

  const err = Object.assign(
    new Error(`Unsupported video format "${file.mimetype}". Accepted: MP4, MOV, WebM, AVI.`),
    { statusCode: 400, code: 'INVALID_VIDEO_TYPE' }
  );
  cb(err, false);
}

// ── Multer instance ───────────────────────────────────────────────────────────

const _multer = multer({
  storage,
  fileFilter,
  limits: {
    fileSize:  MAX_BYTES,
    files:     1,          // only one video per request
    fields:    5,          // small number of text fields alongside
  },
});

// ── Exported middleware ───────────────────────────────────────────────────────

/**
 * Single-file upload on field name "video".
 * Wraps multer so we can return a clean JSON error instead of a throw.
 *
 * Usage in a route:
 *   router.post('/submit', uploadVideoKyc, controller.submitVideoKyc);
 */
function uploadVideoKyc(req, res, next) {
  _multer.single('video')(req, res, (err) => {
    if (!err) return next();

    // Translate multer errors into our standard R.badRequest shape
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `Video file is too large. Maximum allowed size is ${MAX_MB} MB.`,
      });
    }

    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Only one video file can be uploaded per request.',
      });
    }

    if (err.code === 'INVALID_VIDEO_TYPE' || err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }

    // Unknown multer / OS error
    logger.error(`[VideoUpload] Unexpected upload error: ${err.message}`);
    next(err);
  });
}

// ── Helper: delete a video file from disk ────────────────────────────────────

/**
 * Safely deletes a stored video file (e.g. when user cancels submission).
 * Silently swallows ENOENT so callers don't need to worry about missing files.
 */
function deleteVideoFile(videoPath) {
  if (!videoPath) return;
  fs.unlink(videoPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn(`[VideoUpload] Could not delete ${videoPath}: ${err.message}`);
    } else if (!err) {
      logger.info(`[VideoUpload] Deleted video file: ${videoPath}`);
    }
  });
}

/**
 * Returns the absolute path for a stored video.
 * Useful for serving the file to admins.
 */
function resolveVideoPath(relativePath) {
  if (!relativePath) return null;
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.resolve(relativePath);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _safeExt(originalname, mimetype) {
  const fromName = path.extname(originalname || '').toLowerCase();
  if (ALLOWED_EXTS.has(fromName)) return fromName;

  // Fall back to mime-to-ext map
  const mimeMap = {
    'video/mp4':         '.mp4',
    'video/quicktime':   '.mov',
    'video/x-msvideo':  '.avi',
    'video/webm':        '.webm',
    'video/mpeg':        '.mpeg',
    'video/3gpp':        '.3gp',
    'video/x-matroska': '.mkv',
  };
  return mimeMap[mimetype] ?? '.mp4';
}

module.exports = { uploadVideoKyc, deleteVideoFile, resolveVideoPath };