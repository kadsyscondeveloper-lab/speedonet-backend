const authService   = require('../services/authService');
const tokenService  = require('../services/tokenService');
const { maskPhone } = require('../utils/helpers');
const R             = require('../utils/response');
const logger        = require('../utils/logger');
const crypto        = require('crypto');

// Helper: parse JWT expiry string to ms
function jwtExpiryToMs(str = '7d') {
  const unit = str.slice(-1);
  const val  = parseInt(str);
  const map  = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * (map[unit] || 86400000);
}

function getClientInfo(req) {
  return {
    deviceInfo: req.headers['user-agent'] || null,
    ipAddress:  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
  };
}

// =============================================================================
// POST /api/auth/signup
// =============================================================================
async function signup(req, res, next) {
  try {
    const { name, phone, email, password, referral_code } = req.body;

    // 1. Check phone not already registered
    const existing = await authService.findUserByPhone(phone);
    if (existing) {
      return R.conflict(res, 'This mobile number is already registered.');
    }

    // 2. Create user
    const user = await authService.createUser({ name, phone, email, password });

    // 3. Auto-generate a referral code for the new user
    const refCode = phone.slice(-4) + crypto.randomBytes(4).toString('hex').toUpperCase();
    await authService.createReferralCode(user.id, refCode);

    // 4. If a referral code was provided, link the referral
    if (referral_code) {
      const referrer = await authService.findReferralCode(referral_code);
      if (referrer && referrer.user_id !== user.id) {
        await authService.applyReferral(referrer.user_id, user.id, referral_code);
        logger.info(`Referral applied: ${referrer.user_id} → ${user.id}`);
      }
    }

    // 5. Issue tokens
    const accessToken  = tokenService.signAccessToken({ sub: user.id, phone: user.phone, role: 'user' });
    const refreshToken = tokenService.signRefreshToken(user.id);
    const { deviceInfo, ipAddress } = getClientInfo(req);
    const expiresAt = new Date(Date.now() + jwtExpiryToMs(process.env.JWT_EXPIRES_IN));

    await authService.saveSession(user.id, accessToken, expiresAt, deviceInfo, ipAddress);

    logger.info(`New user registered: ${maskPhone(phone)} (id=${user.id})`);

    return R.created(res, {
      user: {
        id:             user.id,
        name:           user.name,
        phone:          user.phone,
        email:          user.email,
        wallet_balance: user.wallet_balance,
        referral_code:  refCode,
      },
      tokens: { access_token: accessToken, refresh_token: refreshToken },
    }, 'Account created successfully');

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/login  (password-based)
// =============================================================================
async function loginWithPassword(req, res, next) {
  try {
    const { phone, password } = req.body;

    // 1. Find user
    const user = await authService.findUserByPhone(phone);
    if (!user) {
      return R.unauthorized(res, 'Invalid mobile number or password.');
    }

    if (!user.is_active) {
      return R.unauthorized(res, 'Your account has been deactivated. Contact support.');
    }

    // 2. Verify password
    const valid = await authService.verifyPassword(password, user.password_hash);
    if (!valid) {
      return R.unauthorized(res, 'Invalid mobile number or password.');
    }

    // 3. Issue tokens + save session
    const accessToken  = tokenService.signAccessToken({ sub: user.id, phone: user.phone, role: 'user' });
    const refreshToken = tokenService.signRefreshToken(user.id);
    const { deviceInfo, ipAddress } = getClientInfo(req);
    const expiresAt = new Date(Date.now() + jwtExpiryToMs(process.env.JWT_EXPIRES_IN));

    await authService.saveSession(user.id, accessToken, expiresAt, deviceInfo, ipAddress);

    logger.info(`Login (password): ${maskPhone(phone)} (id=${user.id})`);

    return R.ok(res, {
      user: {
        id:             user.id,
        name:           user.name,
        phone:          user.phone,
        email:          user.email,
        wallet_balance: user.wallet_balance,
      },
      tokens: { access_token: accessToken, refresh_token: refreshToken },
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/otp/send
// =============================================================================
async function sendOtp(req, res, next) {
  try {
    const { phone, purpose = 'login' } = req.body;

    // If purpose is 'login' and user doesn't exist, tell them to sign up
    if (purpose === 'login') {
      const user = await authService.findUserByPhone(phone);
      if (!user) {
        return R.notFound(res, 'No account found with this mobile number. Please sign up.');
      }
      if (!user.is_active) {
        return R.unauthorized(res, 'Account is deactivated.');
      }
    }

    await authService.createOtp(phone, purpose);

    // In dev, surface the OTP in the response so you can test without SMS
    const devOtp = process.env.OTP_BYPASS_DEV === 'true' && process.env.NODE_ENV !== 'production'
      ? { _dev_otp: '123456' }
      : {};

    return R.ok(res, {
      phone:      maskPhone(phone),
      expires_in: `${process.env.OTP_EXPIRY_MINUTES || 10} minutes`,
      ...devOtp,
    }, `OTP sent to ${maskPhone(phone)}`);

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/otp/verify  (OTP login)
// =============================================================================
async function verifyOtp(req, res, next) {
  try {
    const { phone, otp } = req.body;

    const valid = await authService.verifyOtp(phone, otp, 'login');
    if (!valid) {
      return R.unauthorized(res, 'Incorrect or expired OTP. Please try again.');
    }

    const user = await authService.findUserByPhone(phone);
    if (!user || !user.is_active) {
      return R.unauthorized(res, 'Account not found or deactivated.');
    }

    const accessToken  = tokenService.signAccessToken({ sub: user.id, phone: user.phone, role: 'user' });
    const refreshToken = tokenService.signRefreshToken(user.id);
    const { deviceInfo, ipAddress } = getClientInfo(req);
    const expiresAt = new Date(Date.now() + jwtExpiryToMs(process.env.JWT_EXPIRES_IN));

    await authService.saveSession(user.id, accessToken, expiresAt, deviceInfo, ipAddress);

    logger.info(`Login (OTP): ${maskPhone(phone)} (id=${user.id})`);

    return R.ok(res, {
      user: {
        id:             user.id,
        name:           user.name,
        phone:          user.phone,
        email:          user.email,
        wallet_balance: user.wallet_balance,
      },
      tokens: { access_token: accessToken, refresh_token: refreshToken },
    }, 'Login successful');

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/forgot-password  → sends OTP
// =============================================================================
async function forgotPassword(req, res, next) {
  try {
    const { phone } = req.body;

    const user = await authService.findUserByPhone(phone);
    // Always return OK to prevent user enumeration
    if (!user || !user.is_active) {
      return R.ok(res, null, `If an account exists for ${maskPhone(phone)}, a reset OTP has been sent.`);
    }

    await authService.createOtp(phone, 'forgot_password');

    const devOtp = process.env.OTP_BYPASS_DEV === 'true' && process.env.NODE_ENV !== 'production'
      ? { _dev_otp: '123456' }
      : {};

    return R.ok(res, {
      phone: maskPhone(phone),
      ...devOtp,
    }, `Reset OTP sent to ${maskPhone(phone)}`);

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/reset-password
// =============================================================================
async function resetPassword(req, res, next) {
  try {
    const { phone, otp, new_password } = req.body;

    const valid = await authService.verifyOtp(phone, otp, 'forgot_password');
    if (!valid) {
      return R.unauthorized(res, 'Invalid or expired OTP.');
    }

    const user = await authService.findUserByPhone(phone);
    if (!user) return R.notFound(res, 'Account not found.');

    await authService.updatePassword(user.id, new_password);

    // Revoke all existing sessions so other devices are logged out
    await authService.revokeAllUserSessions(user.id);

    logger.info(`Password reset for user ${user.id}`);

    return R.ok(res, null, 'Password updated successfully. Please log in again.');

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/refresh  → exchange refresh token for new access token
// =============================================================================
async function refreshToken(req, res, next) {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return R.badRequest(res, 'Refresh token required.');

    let decoded;
    try {
      decoded = tokenService.verifyToken(refresh_token);
    } catch {
      return R.unauthorized(res, 'Invalid or expired refresh token.');
    }

    if (decoded.type !== 'refresh') {
      return R.unauthorized(res, 'Not a refresh token.');
    }

    const user = await authService.findUserById(decoded.sub);
    if (!user || !user.is_active) {
      return R.unauthorized(res, 'Account not found or deactivated.');
    }

    const newAccess  = tokenService.signAccessToken({ sub: user.id, phone: user.phone, role: 'user' });
    const newRefresh = tokenService.signRefreshToken(user.id);
    const { deviceInfo, ipAddress } = getClientInfo(req);
    const expiresAt = new Date(Date.now() + jwtExpiryToMs(process.env.JWT_EXPIRES_IN));

    await authService.saveSession(user.id, newAccess, expiresAt, deviceInfo, ipAddress);

    return R.ok(res, {
      tokens: { access_token: newAccess, refresh_token: newRefresh },
    }, 'Token refreshed');

  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/logout
// =============================================================================
async function logout(req, res, next) {
  try {
    await authService.revokeSession(req.token);
    return R.ok(res, null, 'Logged out successfully.');
  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/logout-all  (revoke all devices)
// =============================================================================
async function logoutAll(req, res, next) {
  try {
    await authService.revokeAllUserSessions(req.user.id);
    return R.ok(res, null, 'Logged out from all devices.');
  } catch (err) {
    next(err);
  }
}

// =============================================================================
// GET /api/auth/me
// =============================================================================
async function me(req, res, next) {
  try {
    const user = await authService.findUserById(req.user.id);
    if (!user) return R.notFound(res, 'User not found.');
    return R.ok(res, { user });
  } catch (err) {
    next(err);
  }
}

// =============================================================================
// POST /api/auth/change-password
// =============================================================================

async function changePassword(req, res, next) {
  try {
    const { old_password, new_password } = req.body;

    // 1. Fetch user with password hash
    const user = await authService.findUserByPhone(
      (await authService.findUserById(req.user.id)).phone
    );
    if (!user) return R.notFound(res, 'User not found.');

    // 2. Verify old password
    const valid = await authService.verifyPassword(old_password, user.password_hash);
    if (!valid) {
      return R.unauthorized(res, 'Old password is incorrect.');
    }

    // 3. Update to new password
    await authService.updatePassword(req.user.id, new_password);

    logger.info(`Password changed for user ${req.user.id}`);
    return R.ok(res, null, 'Password changed successfully.');

  } catch (err) {
    next(err);
  }
}

module.exports = {
  signup,
  loginWithPassword,
  sendOtp,
  verifyOtp,
  forgotPassword,
  resetPassword,
  changePassword,
  refreshToken,
  logout,
  logoutAll,
  me,
};