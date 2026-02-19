require('dotenv').config();
const app    = require('./app');
const { getPool } = require('./config/db');
const logger = require('./utils/logger');
const fs     = require('fs');

// Ensure logs directory exists
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const PORT = parseInt(process.env.PORT || '3000');

async function start() {
  try {
    // Test DB connection before accepting traffic
    await getPool();
    logger.info('Database connection established ✓');

    app.listen(PORT, () => {
      logger.info(`Speedonet API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
      logger.info(`Health: http://localhost:${PORT}/api/v1/health`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

start();