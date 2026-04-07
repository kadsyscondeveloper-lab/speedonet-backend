/**
 * server.js  (UPDATED)
 *
 * Changes from original:
 *   1. Creates an explicit http.Server (needed for Socket.io)
 *   2. Attaches the tracking Socket.io namespace
 */

require('dotenv').config();
const http   = require('http');
const app    = require('./app');
const { connectDb }           = require('./config/db');
const { attachTrackingSocket } = require('./socket/trackingSocket');
const logger  = require('./utils/logger');
const fs      = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const PORT = parseInt(process.env.PORT || '3000');

async function start() {
  try {
    await connectDb();
    logger.info('Database connection established ✓');

    // ── Create HTTP server (required for Socket.io) ──────────────────────────
    const httpServer = http.createServer(app);

    // ── Attach live-tracking Socket.io ───────────────────────────────────────
    attachTrackingSocket(httpServer);

    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Speedonet API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
      logger.info(`Local:  http://localhost:${PORT}/api/v1/health`);
      logger.info(`Public: http://103.88.81.7:${PORT}/api/v1/health`);
      logger.info(`Socket: ws://103.88.81.7:${PORT}/tracking/technician`);
      logger.info(`Socket: ws://103.88.81.7:${PORT}/tracking/user`);
    });

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

start();