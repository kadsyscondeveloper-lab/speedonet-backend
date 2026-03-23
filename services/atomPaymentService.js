// services/atomPaymentService.js
//
// ── NTT DATA / Atom Payment Gateway — UAT / TEST Integration ─────────────────
//
// UAT Payment URL : https://caller.atomtech.in/ots/aipay/auth
// CDN             : https://pgtest.atomtech.in/staticdata/ots/js/atomcheckout.js
//
// Flow:
// 1. Build pipe-separated string
// 2. AES-256-CBC encrypt using HashRequestKey + AESRequestSalt
// 3. Send encData to frontend
// 4. Frontend auto-posts to Atom URL
// 5. Atom redirects to callback with encData
// 6. Decrypt response using HashResponseKey + AESResponseSalt
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const logger = require('../utils/logger');

const isUAT = (process.env.ATOM_MODE || 'LIVE').toUpperCase() === 'UAT';

const ATOM_CONFIG = {
  mercId:      isUAT ? process.env.ATOM_UAT_MERC_ID      : process.env.ATOM_LIVE_MERC_ID,
  prodId:      isUAT ? process.env.ATOM_UAT_PROD_ID      : process.env.ATOM_LIVE_PROD_ID,
  password:    isUAT ? process.env.ATOM_UAT_TXN_PASSWORD : process.env.ATOM_LIVE_TXN_PASSWORD,
  atomUrl:     isUAT ? process.env.ATOM_UAT_AUTH_API_URL : process.env.ATOM_LIVE_AUTH_API_URL,
  callbackUrl: process.env.ATOM_CALLBACK_URL,
  hashReqKey:  isUAT ? process.env.ATOM_UAT_HASH_REQ_KEY : process.env.ATOM_LIVE_HASH_REQ_KEY,
  hashResKey:  isUAT ? process.env.ATOM_UAT_HASH_RES_KEY : process.env.ATOM_LIVE_HASH_RES_KEY,
  aesReqKey:   isUAT ? process.env.ATOM_UAT_AES_REQ_KEY  : process.env.ATOM_LIVE_AES_REQ_KEY,
  aesReqSalt:  isUAT ? process.env.ATOM_UAT_AES_REQ_SALT : process.env.ATOM_LIVE_AES_REQ_SALT,
  aesResKey:   isUAT ? process.env.ATOM_UAT_AES_RES_KEY  : process.env.ATOM_LIVE_AES_RES_KEY,
  aesResSalt:  isUAT ? process.env.ATOM_UAT_AES_RES_SALT : process.env.ATOM_LIVE_AES_RES_SALT,
};

// ── AES Encrypt (Request) ─────────────────────────────────────────────────────
// Algorithm matches Dart SDK source (lib/src/functions/a_e_s_helper.dart):
//   PBKDF2(password=key, salt=utf8(key), iterations=65536, bits=256, digest=SHA512)
//   IV = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]
//   Cipher = AES-256-CBC
//   Output = HEX encoded (not base64)

async function _aesEncrypt(plainText, key) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(key, 'utf8');
    crypto.pbkdf2(key, salt, 65536, 32, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      const iv     = Buffer.from([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
      const cipher = crypto.createCipheriv('aes-256-cbc', derivedKey, iv);
      const enc    = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
      resolve(enc.toString('hex').toUpperCase());
    });
  });
}

// ── AES Decrypt (Response) ────────────────────────────────────────────────────

async function _aesDecrypt(encryptedHex, key) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(key, 'utf8');
    crypto.pbkdf2(key, salt, 65536, 32, 'sha512', (err, derivedKey) => {
      if (err) return reject(err);
      const iv       = Buffer.from([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
      const encBytes = Buffer.from(encryptedHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
      const dec      = Buffer.concat([decipher.update(encBytes), decipher.final()]);
      resolve(dec.toString('utf8'));
    });
  });
}

// ── Build Pipe String ─────────────────────────────────────────────────────────
// Format: login|password|txnid|amount|prodid|udf1|udf2|udf3|udf4|udf5|email|mobile

function _buildRequestString({ txnid, amount, email, mobile }) {
  return [
    ATOM_CONFIG.mercId,
    ATOM_CONFIG.password,
    txnid,
    amount,
    ATOM_CONFIG.prodId,
    '', '', '', '', '',   // udf1-5
    email  || '',
    mobile || '',
  ].join('|');
}

// ── Initiate Payment ──────────────────────────────────────────────────────────

function initiatePayment({ txnid, amt, custEmail = '', custMobile = '' }) {
  logger.info(`[Atom] Initiating | txnid=${txnid} amt=${amt}`);

  const plainText = _buildRequestString({
    txnid,
    amount: amt,
    email:  custEmail,
    mobile: custMobile,
  });

  logger.debug(`[Atom] Plain String: ${plainText}`);

  // Returns a promise — caller must await
  return _aesEncrypt(plainText, ATOM_CONFIG.aesReqKey).then(encData => {
    return {
      atomUrl: ATOM_CONFIG.atomUrl,
      encData,
      ru:    ATOM_CONFIG.callbackUrl,
      login: ATOM_CONFIG.mercId,
    };
  });
}

// ── Process Callback ──────────────────────────────────────────────────────────

async function processCallback(body) {
  const encData = body?.encData || body?.encdata || body?.EncData;

  // ── Handle Atom cancel/error special strings ──────────────────────────────
  if (!encData || encData === 'cancelTransaction' || encData === 'errorTransaction') {
    logger.info(`[Atom] Transaction cancelled/errored by user`);
    return {
      success:   false,
      txnid:     body?.merchId !== 'cancelTransaction' ? body?.merchId : null,
      atomtxnId: null,
      bankTxnId: null,
      amt:       null,
      txnStatus: encData,
      params:    null,
    };
  }

  let decrypted;
  try {
    decrypted = await _aesDecrypt(encData, ATOM_CONFIG.aesResKey);
  } catch (e) {
    logger.error(`[Atom] Decryption failed: ${e.message}`);
    throw Object.assign(new Error('Invalid encrypted response'), { statusCode: 400 });
  }

  logger.debug(`[Atom] Decrypted: ${decrypted}`);

  // Atom response is JSON
  let json;
  try {
    json = JSON.parse(decrypted);
  } catch (e) {
    logger.error(`[Atom] JSON parse failed: ${e.message}`);
    throw Object.assign(new Error('Invalid response format'), { statusCode: 400 });
  }

  const pi         = json.payInstrument;
  const orderRef   = pi?.merchDetails?.merchTxnId;
  const atomTxnId  = pi?.payDetails?.atomTxnId?.toString();
  const bankTxnId  = pi?.payModeSpecificData?.bankDetails?.bankTxnId;
  const amount     = pi?.payDetails?.totalAmount?.toString();
  const statusCode = pi?.responseDetails?.statusCode;
  const success    = statusCode === 'OTS0000' || statusCode === 'OTS0551';

  logger.info(`[Atom] Callback | orderRef=${orderRef} atomTxnId=${atomTxnId} status=${statusCode} success=${success}`);

  return {
    success,
    txnid:     orderRef,   // our order_ref
    atomtxnId: atomTxnId,
    bankTxnId: bankTxnId,
    amt:       amount,
    txnStatus: statusCode,
    params:    pi,
  };
}

module.exports = {
  initiatePayment,
  processCallback,
  ATOM_CONFIG,
};