const { verifyToken }  = require('../services/tokenService');
const { findSession }  = require('../services/authService');
const R = require('../utils/response');

/**
 * Protect a route — verifies JWT and checks the session is still alive in DB.
 * Attaches req.user = { id, phone, role }
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return R.unauthorized(res, 'No token provided');
    }

    const token = authHeader.slice(7);

    // 1. Verify signature & expiry
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      return R.unauthorized(res, 'Invalid or expired token');
    }

    // 2. Check the session still exists in the DB (handles logout / revocation)
    const session = await findSession(token);
    if (!session) {
      return R.unauthorized(res, 'Session has been revoked. Please log in again.');
    }

    if (!session.is_active) {
      return R.unauthorized(res, 'Your account has been deactivated.');
    }

    // 3. Attach user info for downstream controllers
    req.user  = { id: decoded.sub, phone: decoded.phone, role: decoded.role || 'user' };
    req.token = token;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Only allow admin roles through.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role === 'user') {
    return R.forbidden(res, 'Admin access required');
  }
  next();
}

module.exports = { authenticate, requireAdmin,verifyToken };