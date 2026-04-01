// services/tokenService.js
const jwt = require('jsonwebtoken');

const SECRET          = process.env.JWT_SECRET;
const EXPIRES_IN      = process.env.JWT_EXPIRES_IN              || '7d';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN      || '30d';
const ADMIN_EXPIRES   = process.env.JWT_ADMIN_EXPIRES_IN        || '8h';
const TECH_EXPIRES    = process.env.JWT_TECHNICIAN_EXPIRES_IN   || '30d';

/**
 * Sign an access token for app users.
 * Payload: { sub: userId, phone, role: 'user' }
 */
function signAccessToken(payload) {
  return jwt.sign(payload, SECRET, {
    expiresIn: EXPIRES_IN,
    issuer:    'speedonet',
    audience:  'speedonet-app',
  });
}

/**
 * Sign a refresh token for app users (longer-lived, minimal payload).
 */
function signRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, SECRET, {
    expiresIn: REFRESH_EXPIRES,
    issuer:    'speedonet',
    audience:  'speedonet-app',
  });
}

/**
 * Sign an access token for admin dashboard users.
 * Payload: { sub: adminId, email, role, type: 'admin' }
 */
function signAdminAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'admin' }, SECRET, {
    expiresIn: ADMIN_EXPIRES,
    issuer:    'speedonet',
    audience:  'speedonet-app',
  });
}

/**
 * Sign an access token for technician app.
 * Payload: { sub: technicianId, phone, employee_id, type: 'technician' }
 */
function signTechnicianAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'technician' }, SECRET, {
    expiresIn: TECH_EXPIRES,
    issuer:    'speedonet',
    audience:  'speedonet-app',
  });
}

/**
 * Verify any token. Throws if invalid / expired.
 */
function verifyToken(token) {
  return jwt.verify(token, SECRET, {
    issuer:   'speedonet',
    audience: 'speedonet-app',
  });
}

/**
 * Decode without verification (for logging / debugging only).
 */
function decodeToken(token) {
  return jwt.decode(token);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  signAdminAccessToken,
  signTechnicianAccessToken,
  verifyToken,
  decodeToken,
};