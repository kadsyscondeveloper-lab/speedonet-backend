/**
 * routes/adminAuth.js
 *
 * Admin dashboard authentication — completely separate from the app user auth.
 * Uses dbo.admin_users table.
 *
 * Mount in routes/index.js:
 *   router.use('/admin/auth', require('./adminAuth'));
 */

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { db }                     = require('../config/db');
const tokenService               = require('../services/tokenService');
const { authenticateAdmin }      = require('../middleware/adminAuth');
const R                          = require('../utils/response');
const logger                     = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function jwtExpiryToMs(str = '8h') {
  const unit = str.slice(-1);
  const val  = parseInt(str);
  const map  = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * (map[unit] || 3600000);
}

// ── Validation ────────────────────────────────────────────────────────────────

const loginRules = [
  body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return R.badRequest(res, 'Validation failed', errors.array().map(e => ({ field: e.path, message: e.msg })));
  }
  next();
}

// =============================================================================
// POST /admin/auth/login
// =============================================================================
router.post('/login', loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const admin = await db
      .selectFrom('dbo.admin_users')
      .select(['id', 'name', 'email', 'password_hash', 'role', 'is_active'])
      .where('email', '=', email)
      .executeTakeFirst();

    // Generic message prevents user enumeration
    if (!admin || !admin.is_active) {
      return R.unauthorized(res, 'Invalid email or password.');
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return R.unauthorized(res, 'Invalid email or password.');
    }

    // Sign an admin-specific token (type: 'admin' distinguishes it from user tokens)
    const accessToken = tokenService.signAdminAccessToken({
      sub:   Number(admin.id),
      email: admin.email,
      role:  admin.role,
    });

    logger.info(`[AdminAuth] Login: ${admin.email} (id=${admin.id}, role=${admin.role})`);

    return R.ok(res, {
      admin: {
        id:    Number(admin.id),
        name:  admin.name,
        email: admin.email,
        role:  admin.role,
      },
      token: accessToken,
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
});

// =============================================================================
// GET /admin/auth/me  — verify token + return profile
// =============================================================================
router.get('/me', authenticateAdmin, async (req, res, next) => {
  try {
    const admin = await db
      .selectFrom('dbo.admin_users')
      .select(['id', 'name', 'email', 'role', 'created_at'])
      .where('id', '=', BigInt(req.admin.id))
      .executeTakeFirst();

    if (!admin) return R.notFound(res, 'Admin not found');

    return R.ok(res, { admin: { ...admin, id: Number(admin.id) } });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// POST /admin/auth/create-admin
// Superadmin only — creates a new admin user
// =============================================================================
const createAdminRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ min: 2, max: 100 }),
  body('email').trim().isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role')
    .isIn(['superadmin', 'admin', 'support_agent', 'billing_agent'])
    .withMessage('Invalid role'),
];

router.post('/create-admin', authenticateAdmin, createAdminRules, validate, async (req, res, next) => {
  try {
    // Only superadmins can create other admins
    if (req.admin.role !== 'superadmin') {
      return R.forbidden(res, 'Only superadmins can create admin accounts');
    }

    const { name, email, password, role } = req.body;

    const existing = await db
      .selectFrom('dbo.admin_users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();

    if (existing) return R.conflict(res, 'An admin with this email already exists.');

    const hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12'));

    const row = await db
      .insertInto('dbo.admin_users')
      .values({ name, email, password_hash: hash, role })
      .output(['inserted.id', 'inserted.name', 'inserted.email', 'inserted.role'])
      .executeTakeFirstOrThrow();

    logger.info(`[AdminAuth] Admin created: ${email} (role=${role}) by ${req.admin.email}`);

    return R.created(res, { admin: { ...row, id: Number(row.id) } }, 'Admin account created successfully');
  } catch (err) {
    next(err);
  }
});

module.exports = router;