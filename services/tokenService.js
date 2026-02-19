const jwt = require('jsonwebtoken');

const SECRET          = process.env.JWT_SECRET;
const EXPIRES_IN      = process.env.JWT_EXPIRES_IN      || '7d';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

/**
 * Sign an access token.
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
 * Sign a refresh token (longer-lived, minimal payload).
 */
function signRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, SECRET, {
    expiresIn: REFRESH_EXPIRES,
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

module.exports = { signAccessToken, signRefreshToken, verifyToken, decodeToken };