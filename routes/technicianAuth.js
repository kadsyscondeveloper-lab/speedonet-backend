/**
 * routes/technicianAuth.js
 *
 * Technician authentication — completely separate from admin and app user auth.
 * Uses dbo.technicians table.
 *
 * Mount in routes/index.js:
 *   router.use('/technician/auth', require('./technicianAuth'));
 */

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { db }                     = require('../config/db');
const tokenService               = require('../services/tokenService');
const { authenticateTechnician } = require('../middleware/technicianAuth');
const R                          = require('../utils/response');
const logger                     = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return R.badRequest(res, 'Validation failed',
      errors.array().map(e => ({ field: e.path, message: e.msg })));
  }
  next();
}

// ── POST /technician/auth/login ───────────────────────────────────────────────
router.post('/login', [
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
], async (req, res, next) => {
  try {
    const { phone, password } = req.body;

    const tech = await db
      .selectFrom('dbo.technicians')
      .select(['id', 'name', 'phone', 'employee_id', 'email',
               'password_hash', 'is_active', 'current_load'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    if (!tech || !tech.is_active)
      return R.unauthorized(res, 'Invalid phone number or password.');

    const valid = await bcrypt.compare(password, tech.password_hash);
    if (!valid)
      return R.unauthorized(res, 'Invalid phone number or password.');

    const accessToken = tokenService.signTechnicianAccessToken({
      sub:         Number(tech.id),
      phone:       tech.phone,
      employee_id: tech.employee_id,
    });

    logger.info(`[TechAuth] Login: ${tech.phone} (id=${tech.id})`);

    return R.ok(res, {
      technician: {
        id:          Number(tech.id),
        name:        tech.name,
        phone:       tech.phone,
        employee_id: tech.employee_id,
        email:       tech.email,
        current_load: tech.current_load,
      },
      token: accessToken,
    }, 'Login successful');

  } catch (err) { next(err); }
});

// ── GET /technician/auth/me ───────────────────────────────────────────────────
router.get('/me', authenticateTechnician, async (req, res, next) => {
  try {
    const tech = await db
      .selectFrom('dbo.technicians')
      .select(['id', 'name', 'phone', 'employee_id', 'email',
               'is_active', 'current_load', 'created_at'])
      .where('id', '=', BigInt(req.technician.id))
      .executeTakeFirst();

    if (!tech) return R.notFound(res, 'Technician not found.');
    return R.ok(res, { technician: { ...tech, id: Number(tech.id) } });
  } catch (err) { next(err); }
});

// ── POST /technician/auth/change-password ─────────────────────────────────────
router.post('/change-password', authenticateTechnician, [
  body('old_password').notEmpty().withMessage('Old password is required'),
  body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 chars'),
  validate,
], async (req, res, next) => {
  try {
    const { old_password, new_password } = req.body;

    const tech = await db
      .selectFrom('dbo.technicians')
      .select(['id', 'password_hash'])
      .where('id', '=', BigInt(req.technician.id))
      .executeTakeFirst();

    const valid = await bcrypt.compare(old_password, tech.password_hash);
    if (!valid) return R.unauthorized(res, 'Old password is incorrect.');

    const hash = await bcrypt.hash(new_password, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    await db.updateTable('dbo.technicians')
      .set({ password_hash: hash })
      .where('id', '=', BigInt(req.technician.id))
      .execute();

    return R.ok(res, null, 'Password changed successfully.');
  } catch (err) { next(err); }
});

// ── POST /technician/auth/fcm-token ──────────────────────────────────────────
router.post('/fcm-token', authenticateTechnician, [
  body('token').trim().notEmpty().withMessage('FCM token is required'),
  validate,
], async (req, res, next) => {
  try {
    const { token } = req.body;
    const techId = BigInt(req.technician.id);

    const existing = await db
      .selectFrom('dbo.technician_fcm_tokens')
      .select(['id', 'technician_id'])
      .where('token', '=', token)
      .executeTakeFirst();

    if (existing) {
      if (Number(existing.technician_id) !== req.technician.id) {
        await db.updateTable('dbo.technician_fcm_tokens')
          .set({ technician_id: techId, updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
      }
    } else {
      await db.insertInto('dbo.technician_fcm_tokens')
        .values({ technician_id: techId, token })
        .execute();
    }

    return R.ok(res, null, 'FCM token saved.');
  } catch (err) { next(err); }
});

module.exports = router;