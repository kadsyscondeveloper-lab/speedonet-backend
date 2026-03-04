const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');
const R         = require('../utils/response');

// ── Global limiter ─────────────────────────────────────────────────────────────
// 600/15 min — Flutter app fires 8–12 requests on every cold start
const globalLimiter = rateLimit({
  windowMs:        parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:             parseInt(process.env.RATE_LIMIT_MAX       || '600'),
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => R.tooMany(res, 'Too many requests, please try again later.'),
});

// ── Auth limiter ───────────────────────────────────────────────────────────────
// 20/15 min — still blocks brute force, won't trip on normal usage
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20'),
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => R.tooMany(res, 'Too many auth attempts. Please try again in 15 minutes.'),
});

// ── OTP limiter ────────────────────────────────────────────────────────────────
// 5/10 min per phone — accounts for SMS delays causing retries
const otpLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             5,
  keyGenerator:    (req) => req.body?.phone || req.ip,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => R.tooMany(res, 'Too many OTP requests. Please wait before requesting another.'),
});

// ── Admin limiter ──────────────────────────────────────────────────────────────
// Separate generous pool so admin dashboard never competes with app users
const adminLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             1000,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => R.tooMany(res, 'Admin rate limit exceeded.'),
});

// ── Global error handler ──────────────────────────────────────────────────────

function errorHandler(err, req, res, next) {
  logger.error(err);

  // SQL Server duplicate key (unique constraint)
  if (err.number === 2627 || err.number === 2601) {
    return R.conflict(res, 'A record with this value already exists.');
  }

  // SQL Server foreign key violation
  if (err.number === 547) {
    return R.badRequest(res, 'Referenced record does not exist.');
  }

  const statusCode = err.statusCode || 500;
  const message    = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';

  return R.error(res, message, statusCode);
}

// ── 404 fallthrough ───────────────────────────────────────────────────────────

function notFoundHandler(req, res) {
  return R.notFound(res, `Route ${req.method} ${req.path} not found`);
}

module.exports = { errorHandler, notFoundHandler, globalLimiter, authLimiter, otpLimiter, adminLimiter };