const sql = require('mssql');
const logger = require('../utils/logger');

const config = {
  server:   process.env.DB_SERVER,
  port:     parseInt(process.env.DB_PORT || '1433'),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt:                process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
    enableArithAbort:       true,
  },
  pool: {
    max:              10,
    min:              2,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 15000,
  requestTimeout:    15000,
};

let pool = null;

/**
 * Get (or lazily create) the shared connection pool.
 */
async function getPool() {
  if (pool && pool.connected) return pool;
  pool = await sql.connect(config);
  logger.info('SQL Server pool connected');
  return pool;
}

/**
 * Run a parameterised query.
 *
 * @param {string} query  - T-SQL string with @param placeholders
 * @param {Object} params - { paramName: { type: sql.NVarChar(50), value: 'x' } }
 * @returns {sql.IResult}
 */
async function query(queryStr, params = {}) {
  const p = await getPool();
  const request = p.request();

  for (const [name, { type, value }] of Object.entries(params)) {
    request.input(name, type, value);
  }

  return request.query(queryStr);
}

/**
 * Execute a stored procedure.
 *
 * @param {string} procName
 * @param {Object} inputs  - { name: { type, value } }
 * @param {Object} outputs - { name: type }
 */
async function execProc(procName, inputs = {}, outputs = {}) {
  const p = await getPool();
  const request = p.request();

  for (const [name, { type, value }] of Object.entries(inputs)) {
    request.input(name, type, value);
  }
  for (const [name, type] of Object.entries(outputs)) {
    request.output(name, type);
  }

  return request.execute(procName);
}

module.exports = { sql, query, execProc, getPool };