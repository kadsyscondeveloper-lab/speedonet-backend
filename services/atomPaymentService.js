// services/atomPaymentService.js
const crypto = require('crypto');
const axios  = require('axios');
const logger = require('../utils/logger');

const ATOM_CONFIG = {
  mercId:      process.env.ATOM_MERC_ID       || '792811',
  prodId:      process.env.ATOM_PROD_ID        || 'SYSCON',
  hashReqKey:  process.env.ATOM_HASH_REQ_KEY   || '2a63f76ede75f9a022',
  hashResKey:  process.env.ATOM_HASH_RES_KEY   || 'e0e6459946dff4c378',
  aesReqSalt:  process.env.ATOM_AES_REQ_SALT   || '1CFAC0C7097BD6FAA950892F87B45960',
  aesResSalt:  process.env.ATOM_AES_RES_SALT   || 'D32C2C50D8AC0FD983D7A710C64FB2BD',
  authApiUrl:  process.env.ATOM_AUTH_API_URL   || 'https://payment1.atomtech.in/ots/aipay/auth',
  cdnUrl:      process.env.ATOM_CDN_URL        || 'https://psa.atomtech.in/staticdata/ots/js/atomcheckout.js',
  callbackUrl: process.env.ATOM_CALLBACK_URL   || 'http://localhost:3000/api/v1/payments/atom/callback',
};

// ── AES-256-CBC ───────────────────────────────────────────────────────────────

function aesEncrypt(plainText, hashKey, saltHex) {
  const key    = crypto.createHash('sha256').update(hashKey).digest();
  const iv     = Buffer.from(saltHex.substring(0, 32), 'hex');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return cipher.update(plainText, 'utf8', 'base64') + cipher.final('base64');
}

function aesDecrypt(cipherText, hashKey, saltHex) {
  const key      = crypto.createHash('sha256').update(hashKey).digest();
  const iv       = Buffer.from(saltHex.substring(0, 32), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(cipherText, 'base64', 'utf8') + decipher.final('utf8');
}

// ── Hash ──────────────────────────────────────────────────────────────────────

function generateRequestHash({ amt, txnscamt = '0', clientcode, txnid, date, custacc = '' }) {
  const raw = [
    ATOM_CONFIG.hashReqKey,
    ATOM_CONFIG.mercId,
    ATOM_CONFIG.prodId,
    amt,
    'INR',
    txnscamt,
    clientcode,
    txnid,
    date,
    custacc,
  ].join('');
  return crypto.createHash('sha512').update(raw).digest('hex');
}

function verifyResponseHash(params) {
  const raw = [
    ATOM_CONFIG.hashResKey,
    params.mercid,
    params.prodid,
    params.amt,
    params.clientcode,
    params.txnid,
    params.date,
    params.atomtxnId,
    params.bankTxnId,
    params.txnStatus,
  ].join('');
  const expected = crypto.createHash('sha512').update(raw).digest('hex');
  return expected === params.signature;
}

// ── Date format ───────────────────────────────────────────────────────────────

function atomDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Build encrypted request ───────────────────────────────────────────────────

function buildEncryptedRequest({ txnid, amt, clientcode, custacc = '', txnscamt = '0' }) {
  const date = atomDate();
  const hash = generateRequestHash({ amt, txnscamt, clientcode, txnid, date, custacc });

  const plainText = [
    `mercid=${ATOM_CONFIG.mercId}`,
    `prodid=${ATOM_CONFIG.prodId}`,
    `amt=${amt}`,
    `txncurr=INR`,
    `txnscamt=${txnscamt}`,
    `clientcode=${clientcode}`,
    `txnid=${txnid}`,
    `date=${encodeURIComponent(date)}`,
    `custacc=${custacc}`,
    `signature=${hash}`,
    `ru=${encodeURIComponent(ATOM_CONFIG.callbackUrl)}`,
  ].join('&');

  logger.debug(`[Atom] Plain request: ${plainText}`);

  return aesEncrypt(plainText, ATOM_CONFIG.hashReqKey, ATOM_CONFIG.aesReqSalt);
}

// ── Initiate payment ──────────────────────────────────────────────────────────

async function initiatePayment({ txnid, amt, clientcode, custacc = '' }) {
  const encData = buildEncryptedRequest({ txnid, amt, clientcode, custacc });

  logger.info(`[Atom] Calling auth API | txnid=${txnid} amt=${amt}`);
  logger.debug(`[Atom] Auth URL: ${ATOM_CONFIG.authApiUrl}`);
  logger.debug(`[Atom] mercId: ${ATOM_CONFIG.mercId} | encData length: ${encData.length}`);

  let response;
  try {
    response = await axios.post(
      ATOM_CONFIG.authApiUrl,
      new URLSearchParams({
        merchantId: ATOM_CONFIG.mercId,
        encData,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
        // Don't throw on non-2xx so we can log the actual error body
        validateStatus: () => true,
      }
    );
  } catch (netErr) {
    logger.error(`[Atom] Network error calling auth API: ${netErr.message}`);
    throw Object.assign(new Error('Cannot reach payment gateway. Check server internet access.'), { statusCode: 502 });
  }

  // ── Log full raw response for debugging ──────────────────────────────────
  logger.info(`[Atom] Auth API HTTP status: ${response.status}`);
  logger.info(`[Atom] Auth API raw response: ${JSON.stringify(response.data)}`);

  const resBody = typeof response.data === 'string'
    ? response.data
    : JSON.stringify(response.data);

  // Check for Atom error responses (they sometimes return JSON errors)
  if (response.status !== 200) {
    logger.error(`[Atom] Auth API returned HTTP ${response.status}: ${resBody}`);
    throw Object.assign(
      new Error(`Payment gateway returned error ${response.status}. Try again.`),
      { statusCode: 502 }
    );
  }

  // Atom success response format: "encData=<base64>"
  if (!resBody || !resBody.includes('encData=')) {
    logger.error(`[Atom] Unexpected auth response body: "${resBody}"`);
    throw Object.assign(
      new Error('Payment gateway error. Please try again.'),
      { statusCode: 502 }
    );
  }

  // Decrypt response
  let decrypted;
  try {
    const encResData = new URLSearchParams(resBody).get('encData');
    decrypted = aesDecrypt(encResData, ATOM_CONFIG.hashResKey, ATOM_CONFIG.aesResSalt);
    logger.debug(`[Atom] Decrypted auth response: ${decrypted}`);
  } catch (decErr) {
    logger.error(`[Atom] Failed to decrypt auth response: ${decErr.message}`);
    throw Object.assign(new Error('Payment gateway error. Please try again.'), { statusCode: 502 });
  }

  const resParams   = new URLSearchParams(decrypted);
  const atomTokenId = resParams.get('atomTokenId');

  if (!atomTokenId) {
    const errMsg = resParams.get('message') || resParams.get('error') || 'Failed to get payment token';
    logger.error(`[Atom] No atomTokenId in decrypted response: ${decrypted}`);
    throw Object.assign(new Error(errMsg), { statusCode: 502 });
  }

  logger.info(`[Atom] Got atomTokenId for txnid=${txnid}`);
  return { atomTokenId, mercId: ATOM_CONFIG.mercId, cdnUrl: ATOM_CONFIG.cdnUrl };
}

// ── Process callback ──────────────────────────────────────────────────────────

function processCallback(encData) {
  let decrypted;
  try {
    decrypted = aesDecrypt(encData, ATOM_CONFIG.hashResKey, ATOM_CONFIG.aesResSalt);
  } catch (e) {
    logger.error('[Atom] Callback decryption failed:', e.message);
    throw Object.assign(new Error('Invalid callback data'), { statusCode: 400 });
  }

  const params = Object.fromEntries(new URLSearchParams(decrypted));
  logger.info(`[Atom] Callback | txnid=${params.txnid} status=${params.txnStatus}`);

  const hashValid = verifyResponseHash(params);
  if (!hashValid) {
    logger.error('[Atom] Callback hash mismatch — possible tampering!');
    throw Object.assign(new Error('Invalid payment response signature'), { statusCode: 400 });
  }

  return {
    success:   params.txnStatus === 'Ok',
    txnid:     params.txnid,
    atomtxnId: params.atomtxnId,
    bankTxnId: params.bankTxnId,
    amt:       params.amt,
    txnStatus: params.txnStatus,
    params,
  };
}

module.exports = { initiatePayment, processCallback, ATOM_CONFIG };