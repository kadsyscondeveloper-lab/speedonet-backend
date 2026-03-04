/**
 * middleware/adminAuth.js
 *
 * Separate auth middleware for the admin dashboard.
 * Uses dbo.admin_users — completely independent of dbo.users (app users).
 * Admin JWTs carry { sub: adminId, email, role, type: 'admin' }.
 */

const { verifyToken } = require('../services/tokenService');
const { db }          = require('../config/db');
const R               = require('../utils/response');

/**
 * Verify an admin JWT and confirm the admin account is active.
 * Attaches req.admin = { id, email, role }
 */
async function authenticateAdmin(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return R.unauthorized(res, 'No token provided');
    }

    const token = authHeader.slice(7);

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      return R.unauthorized(res, 'Invalid or expired token');
    }

    // Must be an admin token (not a user token)
    if (decoded.type !== 'admin') {
      return R.forbidden(res, 'Admin access required');
    }

    // Confirm admin account still exists and is active
    const admin = await db
      .selectFrom('dbo.admin_users')
      .select(['id', 'email', 'role', 'is_active'])
      .where('id', '=', Number(decoded.sub))
      .executeTakeFirst();

    if (!admin || !admin.is_active) {
      return R.unauthorized(res, 'Admin account not found or deactivated');
    }

    req.admin = { id: Number(admin.id), email: admin.email, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Only allow superadmin role.
 * Use after authenticateAdmin for routes that need elevated privilege.
 */
function requireSuperAdmin(req, res, next) {
  if (!req.admin || req.admin.role !== 'superadmin') {
    return R.forbidden(res, 'Superadmin access required');
  }
  next();
}

module.exports = { authenticateAdmin, requireSuperAdmin };