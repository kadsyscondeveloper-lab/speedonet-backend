require('dotenv').config();
const app    = require('./app');
const { connectDb } = require('./config/db');
const logger = require('./utils/logger');
const fs     = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const PORT = parseInt(process.env.PORT || '3000');

async function start() {
  try {
    await connectDb();
    logger.info('Database connection established ✓');

    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Speedonet API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
      logger.info(`Local: http://localhost:${PORT}/api/v1/health`);
      logger.info(`Public: http://103.88.81.7:${PORT}/api/v1/health`);
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