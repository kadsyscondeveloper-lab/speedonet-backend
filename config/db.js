/**
 * config/db.js
 * Kysely instance using the built-in MssqlDialect with tedious + tarn.
 * Drop-in replacement for the old db.js — export `db` instead of { sql, query, execProc }.
 */

require('dotenv').config();
const { Kysely, MssqlDialect, sql } = require('kysely');
const Tedious = require('tedious');
const Tarn    = require('tarn');
const logger  = require('../utils/logger');

const dialect = new MssqlDialect({
  tarn: {
    ...Tarn,
    options: {
      min:               2,
      max:               10,
      idleTimeoutMillis: 30_000,
    },
  },
  tedious: {
    ...Tedious,
    connectionFactory: () => new Tedious.Connection({
      server: process.env.DB_SERVER,
      authentication: {
        type:    'default',
        options: {
          userName: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
        },
      },
      options: {
        port:                   parseInt(process.env.DB_PORT || '1433'),
        database:               process.env.DB_NAME,
        encrypt:                process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
        connectTimeout:         15_000,
        requestTimeout:         15_000,
      },
    }),
  },
});

const db = new Kysely({
  dialect,
  log: process.env.NODE_ENV !== 'production'
    ? (event) => {
        if (event.level === 'query') logger.debug(`[SQL] ${event.query.sql}`);
        if (event.level === 'error') logger.error(`[SQL ERROR] ${event.error}`);
      }
    : undefined,
});

/**
 * Call once at startup to verify the pool is alive.
 * Replace `await getPool()` in server.js with `await connectDb()`.
 */
async function connectDb() {
  await db.selectFrom('dbo.users').select('id').top(1).execute();
  logger.info('Kysely — SQL Server connection pool ready ✓');
}

module.exports = { db, sql, connectDb };