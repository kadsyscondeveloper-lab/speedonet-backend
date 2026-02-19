const crypto = require('crypto');

/**
 * Generate a numeric OTP of given length.
 * In dev mode (OTP_BYPASS_DEV=true) always returns '123456'.
 */
function generateOtp(length = 6) {
  if (process.env.OTP_BYPASS_DEV === 'true' && process.env.NODE_ENV !== 'production') {
    return '1'.repeat(length - 1) + '6'; // → '123456' for length 6 (demo)
  }
  const max = Math.pow(10, length);
  const min = Math.pow(10, length - 1);
  return String(crypto.randomInt(min, max));
}

/**
 * Generate a unique order reference: SPD-YYYYMMDDHHMMSS-XXXXX
 */
function generateOrderRef() {
  const now   = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SPD-${stamp}-${rand}`;
}

/**
 * OTP expiry datetime (returns a JS Date)
 */
function otpExpiry(minutes) {
  const mins = minutes || parseInt(process.env.OTP_EXPIRY_MINUTES || '10');
  return new Date(Date.now() + mins * 60 * 1000);
}

/**
 * Mask a phone number: 98765*****3
 */
function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone;
  return phone.slice(0, 3) + '*'.repeat(phone.length - 6) + phone.slice(-3);
}

module.exports = { generateOtp, generateOrderRef, otpExpiry, maskPhone };