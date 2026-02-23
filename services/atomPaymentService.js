// services/atomPaymentService.js
//
// ── NTT DATA / Atom Payment Gateway — LEGACY encData Integration ───────────
//
// Flow:
// 1. Build pipe-separated string
// 2. AES-256-CBC encrypt using HashRequestKey + AESRequestSalt
// 3. Send encData to frontend
// 4. Frontend auto-posts to Atom URL
// 5. Atom redirects to callback with encData
// 6. Decrypt response using HashResponseKey + AESResponseSalt
//
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const logger = require('../utils/logger');

const ATOM_CONFIG = {
  mercId:      process.env.ATOM_MERC_ID       || '792811',
  prodId:      process.env.ATOM_PROD_ID       || 'SYSCON',
  password:    process.env.ATOM_TXN_PASSWORD  || 'fb1489ed',

  atomUrl:     process.env.ATOM_AUTH_API_URL  || 'https://payment1.atomtech.in/ots/aipay/auth',
  callbackUrl: process.env.ATOM_CALLBACK_URL  || 'https://kadsyscon.in/api/v1/payments/atom/callback',

  hashReqKey:  process.env.ATOM_HASH_REQ_KEY  || '2a63f76ede75f9a022',
  hashResKey:  process.env.ATOM_HASH_RES_KEY  || 'e0e6459946dff4c378',

  aesReqSalt:  process.env.ATOM_AES_REQ_SALT  || '1CFAC0C7097BD6FAA950892F87B45960',
  aesResSalt:  process.env.ATOM_AES_RES_SALT  || 'D32C2C50D8AC0FD983D7A710C64FB2BD',
};

//
// ── AES Encrypt (Request) ───────────────────────────────────────────────────
//
function _aesEncrypt(plainText, hashKey, saltHex) {
  const key = crypto.createHash('sha256').update(hashKey).digest();
  const iv  = Buffer.from(saltHex.substring(0, 32), 'hex');

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return cipher.update(plainText, 'utf8', 'base64') + cipher.final('base64');
}

//
// ── AES Decrypt (Response) ───────────────────────────────────────────────────
//
function _aesDecrypt(cipherText, hashKey, saltHex) {
  const key = crypto.createHash('sha256').update(hashKey).digest();
  const iv  = Buffer.from(saltHex.substring(0, 32), 'hex');

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(cipherText, 'base64', 'utf8') + decipher.final('utf8');
}

//
// ── Build Legacy Pipe String ─────────────────────────────────────────────────
// Format:
// login|password|txnid|amount|prodid|udf1|udf2|udf3|udf4|udf5|email|mobile
//
function _buildRequestString({ txnid, amount, email, mobile }) {
  return [
    ATOM_CONFIG.mercId,
    ATOM_CONFIG.password,
    txnid,
    amount,
    ATOM_CONFIG.prodId,
    '', '', '', '', '',      // udf1-5
    email || '',
    mobile || ''
  ].join('|');
}

//
// ── Initiate Payment (LEGACY) ───────────────────────────────────────────────
// Returns encData + atomUrl
//
function initiatePayment({ txnid, amt, custEmail = '', custMobile = '' }) {
  logger.info(`[Atom] Legacy Initiating | txnid=${txnid} amt=${amt}`);

  const plainText = _buildRequestString({
    txnid,
    amount: amt,
    email: custEmail,
    mobile: custMobile
  });

  logger.debug(`[Atom] Plain String: ${plainText}`);

  const encData = _aesEncrypt(
    plainText,
    ATOM_CONFIG.hashReqKey,
    ATOM_CONFIG.aesReqSalt
  );

  logger.debug(`[Atom] Generated encData`);

  return {
    atomUrl: ATOM_CONFIG.atomUrl,
    encData,
  };
}

//
// ── Process Callback ─────────────────────────────────────────────────────────
// Atom will POST: encData
//
function processCallback(body) {
  const encData = body?.encData || body?.encdata;

  if (!encData) {
    logger.error('[Atom] No encData received in callback');
    throw Object.assign(new Error('Invalid callback format'), { statusCode: 400 });
  }

  let decrypted;

  try {
    decrypted = _aesDecrypt(
      encData,
      ATOM_CONFIG.hashResKey,
      ATOM_CONFIG.aesResSalt
    );
  } catch (e) {
    logger.error('[Atom] Decryption failed:', e.message);
    throw Object.assign(new Error('Invalid encrypted response'), { statusCode: 400 });
  }

  logger.debug(`[Atom] Decrypted Response: ${decrypted}`);

  const params = Object.fromEntries(new URLSearchParams(decrypted));

  const success = params.txnStatus === 'Ok';

  logger.info(`[Atom] Callback | txnid=${params.txnid} status=${params.txnStatus}`);

  return {
    success,
    txnid:     params.txnid,
    atomtxnId: params.atomtxnId,
    bankTxnId: params.bankTxnId,
    amt:       params.amt,
    txnStatus: params.txnStatus,
    params,
  };
}

module.exports = {
  initiatePayment,
  processCallback,
  ATOM_CONFIG,
};