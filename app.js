const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');
const { globalLimiter, errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger  = require('./utils/logger');

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.NODE_ENV === 'production' ? 'https://speedonet.in' : '*',
  credentials: true,
}));

// ── Request logging ───────────────────────────────────────────────────────────
app.use(morgan('dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Global rate limiter ───────────────────────────────────────────────────────
app.use(globalLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1', require('./routes/index'));

// ── 404 & error handlers ─────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;