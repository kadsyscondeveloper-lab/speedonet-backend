const bcrypt  = require('bcryptjs');
const { sql, query, execProc } = require('../config/db');
const { generateOtp, otpExpiry, maskPhone } = require('../utils/helpers');
const logger = require('../utils/logger');

// ── User lookup ───────────────────────────────────────────────────────────────

async function findUserByPhone(phone) {
  const result = await query(
    `SELECT id, name, phone, email, password_hash, profile_image,
            wallet_balance, is_active
     FROM dbo.users
     WHERE phone = @phone`,
    { phone: { type: sql.NVarChar(15), value: phone } }
  );
  return result.recordset[0] || null;
}

async function findUserById(id) {
  const result = await query(
    `SELECT id, name, phone, email, profile_image, wallet_balance, is_active
     FROM dbo.users WHERE id = @id`,
    { id: { type: sql.BigInt, value: id } }
  );
  return result.recordset[0] || null;
}

// ── Registration ──────────────────────────────────────────────────────────────

async function createUser({ name, phone, email, password }) {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
  const hash   = password ? await bcrypt.hash(password, rounds) : null;

  const result = await query(
    `INSERT INTO dbo.users (name, phone, email, password_hash)
     OUTPUT INSERTED.id, INSERTED.name, INSERTED.phone, INSERTED.email,
            INSERTED.wallet_balance, INSERTED.created_at
     VALUES (@name, @phone, @email, @hash)`,
    {
      name:  { type: sql.NVarChar(100), value: name  },
      phone: { type: sql.NVarChar(15),  value: phone },
      email: { type: sql.NVarChar(150), value: email || null },
      hash:  { type: sql.NVarChar(255), value: hash  },
    }
  );
  return result.recordset[0];
}

// ── Password ──────────────────────────────────────────────────────────────────

async function verifyPassword(plainText, hash) {
  if (!hash) return false;
  return bcrypt.compare(plainText, hash);
}

async function updatePassword(userId, newPassword) {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
  const hash   = await bcrypt.hash(newPassword, rounds);

  await query(
    `UPDATE dbo.users
     SET password_hash = @hash, updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      hash: { type: sql.NVarChar(255), value: hash },
      id:   { type: sql.BigInt,        value: userId },
    }
  );
}

// ── OTP ───────────────────────────────────────────────────────────────────────

async function createOtp(phone, purpose = 'login') {
  const code    = generateOtp(parseInt(process.env.OTP_LENGTH || '6'));
  const expires = otpExpiry();

  // Invalidate any previous unused OTPs for this phone + purpose
  await query(
    `UPDATE dbo.otp_requests SET is_used = 1
     WHERE phone = @phone AND purpose = @purpose AND is_used = 0`,
    {
      phone:   { type: sql.NVarChar(15), value: phone   },
      purpose: { type: sql.NVarChar(20), value: purpose },
    }
  );

  await query(
    `INSERT INTO dbo.otp_requests (phone, otp_code, purpose, expires_at)
     VALUES (@phone, @code, @purpose, @expires)`,
    {
      phone:   { type: sql.NVarChar(15),  value: phone   },
      code:    { type: sql.NVarChar(10),  value: code    },
      purpose: { type: sql.NVarChar(20),  value: purpose },
      expires: { type: sql.DateTime2,     value: expires },
    }
  );

  // In production, send SMS here via your gateway (Twilio, MSG91, etc.)
  logger.debug(`OTP for ${maskPhone(phone)} → ${code}  [${purpose}]`);

  return code; // return for dev/test; never expose in prod response
}

async function verifyOtp(phone, code, purpose = 'login') {
  const result = await query(
    `SELECT TOP 1 id FROM dbo.otp_requests
     WHERE phone   = @phone
       AND otp_code = @code
       AND purpose  = @purpose
       AND is_used  = 0
       AND expires_at > SYSUTCDATETIME()
     ORDER BY created_at DESC`,
    {
      phone:   { type: sql.NVarChar(15), value: phone   },
      code:    { type: sql.NVarChar(10), value: code    },
      purpose: { type: sql.NVarChar(20), value: purpose },
    }
  );

  if (!result.recordset.length) return false;

  // Mark OTP as used
  await query(
    `UPDATE dbo.otp_requests SET is_used = 1 WHERE id = @id`,
    { id: { type: sql.BigInt, value: result.recordset[0].id } }
  );

  return true;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

async function saveSession(userId, token, expiresAt, deviceInfo = null, ipAddress = null) {
  await query(
    `INSERT INTO dbo.user_sessions (user_id, token, device_info, ip_address, expires_at)
     VALUES (@userId, @token, @device, @ip, @expires)`,
    {
      userId:  { type: sql.BigInt,        value: userId     },
      token:   { type: sql.NVarChar(512), value: token      },
      device:  { type: sql.NVarChar(300), value: deviceInfo },
      ip:      { type: sql.NVarChar(45),  value: ipAddress  },
      expires: { type: sql.DateTime2,     value: expiresAt  },
    }
  );
}

async function findSession(token) {
  const result = await query(
    `SELECT s.id, s.user_id, s.expires_at, u.is_active
     FROM dbo.user_sessions s
     JOIN dbo.users u ON u.id = s.user_id
     WHERE s.token = @token
       AND s.expires_at > SYSUTCDATETIME()`,
    { token: { type: sql.NVarChar(512), value: token } }
  );
  return result.recordset[0] || null;
}

async function revokeSession(token) {
  await query(
    `DELETE FROM dbo.user_sessions WHERE token = @token`,
    { token: { type: sql.NVarChar(512), value: token } }
  );
}

async function revokeAllUserSessions(userId) {
  await query(
    `DELETE FROM dbo.user_sessions WHERE user_id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );
}

// ── Referral ──────────────────────────────────────────────────────────────────

async function createReferralCode(userId, code) {
  const url = `https://speedonet.in/refer?code=${code}`;
  await query(
    `INSERT INTO dbo.referral_codes (user_id, code, referral_url)
     VALUES (@userId, @code, @url)`,
    {
      userId: { type: sql.BigInt,        value: userId },
      code:   { type: sql.NVarChar(20),  value: code  },
      url:    { type: sql.NVarChar(500), value: url   },
    }
  );
}

async function applyReferral(referrerId, referredId, code) {
  await query(
    `INSERT INTO dbo.referrals (referrer_id, referred_id, referral_code)
     VALUES (@referrerId, @referredId, @code)`,
    {
      referrerId: { type: sql.BigInt,       value: referrerId },
      referredId: { type: sql.BigInt,       value: referredId },
      code:       { type: sql.NVarChar(20), value: code       },
    }
  );
}

async function findReferralCode(code) {
  const result = await query(
    `SELECT rc.user_id, u.name AS referrer_name
     FROM dbo.referral_codes rc
     JOIN dbo.users u ON u.id = rc.user_id
     WHERE rc.code = @code`,
    { code: { type: sql.NVarChar(20), value: code } }
  );
  return result.recordset[0] || null;
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