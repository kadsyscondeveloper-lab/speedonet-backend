/**
 * services/authService.js
 * Kysely rewrite — identical exports to the original so controllers need no changes.
 */

const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { db, sql } = require('../config/db');
const { generateOtp, otpExpiry, maskPhone } = require('../utils/helpers');
const logger  = require('../utils/logger');

// ── User lookup ───────────────────────────────────────────────────────────────

async function findUserByPhone(phone) {
  const row = await db
    .selectFrom('dbo.users')
    .select([
      'id', 'name', 'phone', 'email',
      'password_hash', 'profile_image',
      'wallet_balance', 'is_active','availability_confirmed', 
    ])
    .where('phone', '=', phone)
    .executeTakeFirst();
  return row ?? null;
}

async function findUserById(id) {
  const row = await db
    .selectFrom('dbo.users')
    .select([
      'id', 'name', 'phone', 'email',
      'profile_image', 'wallet_balance', 'is_active','availability_confirmed',
    ])
    .where('id', '=', BigInt(id))
    .executeTakeFirst();
  return row ?? null;
}

// ── Registration ──────────────────────────────────────────────────────────────

async function createUser({ name, phone, email, password }) {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
  const hash   = password ? await bcrypt.hash(password, rounds) : null;

  return db
    .insertInto('dbo.users')
    .values({ name, phone, email: email ?? null, password_hash: hash })
    .output(['inserted.id', 'inserted.name', 'inserted.phone',
         'inserted.email', 'inserted.wallet_balance', 'inserted.created_at'])
    .executeTakeFirstOrThrow();
}

// ── Password ──────────────────────────────────────────────────────────────────

async function verifyPassword(plainText, hash) {
  if (!hash) return false;
  return bcrypt.compare(plainText, hash);
}

async function updatePassword(userId, newPassword) {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
  const hash   = await bcrypt.hash(newPassword, rounds);

  await db
    .updateTable('dbo.users')
    .set({ password_hash: hash, updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', BigInt(userId))
    .execute();
}

// ── OTP ───────────────────────────────────────────────────────────────────────

async function createOtp(phone, purpose = 'login') {
  const code    = generateOtp(parseInt(process.env.OTP_LENGTH || '6'));
  const expires = otpExpiry();

  // Invalidate previous unused OTPs for this phone + purpose
  await db
    .updateTable('dbo.otp_requests')
    .set({ is_used: true })
    .where('phone',   '=', phone)
    .where('purpose', '=', purpose)
    .where('is_used', '=', false)
    .execute();

  await db
    .insertInto('dbo.otp_requests')
    .values({ phone, otp_code: code, purpose, expires_at: expires })
    .execute();

  logger.debug(`OTP for ${maskPhone(phone)} → ${code}  [${purpose}]`);
  return code;
}

async function verifyOtp(phone, code, purpose = 'login') {
  const row = await db
    .selectFrom('dbo.otp_requests')
    .select('id')
    .where('phone',      '=', phone)
    .where('otp_code',   '=', code)
    .where('purpose',    '=', purpose)
    .where('is_used',    '=', false)
    .where('expires_at', '>', sql`SYSUTCDATETIME()`)
    .orderBy('created_at', 'desc')
    .top(1)
    .executeTakeFirst();

  if (!row) return false;

  await db
    .updateTable('dbo.otp_requests')
    .set({ is_used: true })
    .where('id', '=', row.id)
    .execute();

  return true;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

async function saveSession(userId, token, expiresAt, deviceInfo = null, ipAddress = null) {
  await db
    .insertInto('dbo.user_sessions')
    .values({
      user_id:     BigInt(userId),
      token,
      device_info: deviceInfo,
      ip_address:  ipAddress,
      expires_at:  expiresAt,
    })
    .execute();
}

async function findSession(token) {
  const row = await db
    .selectFrom('dbo.user_sessions as s')
    .innerJoin('dbo.users as u', 'u.id', 's.user_id')
    .select(['s.id', 's.user_id', 's.expires_at', 'u.is_active'])
    .where('s.token',      '=', token)
    .where('s.expires_at', '>', sql`SYSUTCDATETIME()`)
    .executeTakeFirst();
  return row ?? null;
}

async function revokeSession(token) {
  await db
    .deleteFrom('dbo.user_sessions')
    .where('token', '=', token)
    .execute();
}

async function revokeAllUserSessions(userId) {
  await db
    .deleteFrom('dbo.user_sessions')
    .where('user_id', '=', BigInt(userId))
    .execute();
}

// ── Referral ──────────────────────────────────────────────────────────────────

async function createReferralCode(userId, code) {
  const url = `https://speedonet.in/refer?code=${code}`;
  await db
    .insertInto('dbo.referral_codes')
    .values({ user_id: BigInt(userId), code, referral_url: url })
    .execute();
}

async function applyReferral(referrerId, referredId, code) {
  await db
    .insertInto('dbo.referrals')
    .values({
      referrer_id:   BigInt(referrerId),
      referred_id:   BigInt(referredId),
      referral_code: code,
    })
    .execute();
}

async function findReferralCode(code) {
  const row = await db
    .selectFrom('dbo.referral_codes as rc')
    .innerJoin('dbo.users as u', 'u.id', 'rc.user_id')
    .select(['rc.user_id', 'u.name as referrer_name'])
    .where('rc.code', '=', code)
    .executeTakeFirst();
  return row ?? null;
}

module.exports = {
  findUserByPhone,
  findUserById,
  createUser,
  verifyPassword,
  updatePassword,
  createOtp,
  verifyOtp,
  saveSession,
  findSession,
  revokeSession,
  revokeAllUserSessions,
  createReferralCode,
  applyReferral,
  findReferralCode,
};