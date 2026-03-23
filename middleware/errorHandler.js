const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');
const R         = require('../utils/response');

// ── Global limiter ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,  // 15 minutes
  max:             10000,            // was 600 — effectively no limit
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => R.tooMany(res, 'Too many requests, please try again later.'),
});

// ── Auth limiter ───────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             200,              // was 20
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         (req, res) => R.tooMany(res, 'Too many auth attempts. Please try again in 15 minutes.'),
});

// ── OTP limiter ────────────────────────────────────────────────────────────────
const otpLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             20,               // was 5
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