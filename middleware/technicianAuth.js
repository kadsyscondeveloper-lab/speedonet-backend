/**
 * middleware/technicianAuth.js
 *
 * Verifies JWT tokens for technician routes.
 * Token must have type: 'technician' and belong to an active technician.
 */

const tokenService = require('../services/tokenService');
const { db }       = require('../config/db');
const R            = require('../utils/response');

async function authenticateTechnician(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return R.unauthorized(res, 'Authentication required.');

    const token = authHeader.slice(7);

    let decoded;
    try {
      decoded = tokenService.verifyToken(token);
    } catch {
      return R.unauthorized(res, 'Invalid or expired token.');
    }

    if (decoded.type !== 'technician')
      return R.unauthorized(res, 'Invalid token type.');

    const tech = await db
      .selectFrom('dbo.technicians')
      .select(['id', 'name', 'phone', 'employee_id', 'is_active'])
      .where('id', '=', BigInt(decoded.sub))
      .executeTakeFirst();

    if (!tech || !tech.is_active)
      return R.unauthorized(res, 'Account not found or deactivated.');

    req.technician = { ...tech, id: Number(tech.id) };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticateTechnician };