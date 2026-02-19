const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');
const R         = require('../utils/response');

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

// ── Rate limiters ─────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX        || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => R.tooMany(res, 'Too many requests, please try again later.'),
});

// Stricter limiter for auth endpoints to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => R.tooMany(res, 'Too many auth attempts. Please try again in 15 minutes.'),
});

// OTP send limiter — max 3 OTPs per phone per 10 min
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max:      3,
  keyGenerator: (req) => req.body?.phone || req.ip,
  handler: (req, res) => R.tooMany(res, 'Too many OTP requests. Please wait before requesting another.'),
});

module.exports = { errorHandler, notFoundHandler, globalLimiter, authLimiter, otpLimiter };