// services/pgPaymentService.js
//
// ── Payment Gateway (KAD SYSCON) Integration ──────────────────────────────────
//
// Flow:
// 1. Build POST params + SHA-512 hash
// 2. Return params to controller → controller returns to Flutter app
// 3. Flutter opens payment page URL in WebView
// 4. After payment, PG POSTs to callback URL (return_url / return_url_failure)
// 5. Callback handler verifies hash, credits wallet
//
// Docs: Payment Gateway Integration Guide v2.0
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const axios  = require('axios');
const logger = require('../utils/logger');

const PG_CONFIG = {
  apiKey:     process.env.PG_API_KEY    || 'f29acbe5-a475-44ca-a7b9-906766af82b3',
  salt:       process.env.PG_SALT       || '037f34233673b6dd304112e3fa3af14b361233fe',
  pgApiUrl:   process.env.PG_API_URL    || 'pgbiz.omniware.in',
  mode:       process.env.PG_MODE       || 'LIVE',   // 'TEST' or 'LIVE'
  callbackUrl:       process.env.PG_CALLBACK_URL        || 'https://unworshipping-kathrin-parablastic.ngrok-free.dev/api/v1/payments/pg/callback',
  callbackFailUrl:   process.env.PG_CALLBACK_FAIL_URL   || 'https://unworshipping-kathrin-parablastic.ngrok-free.dev/api/v1/payments/pg/callback',
  callbackCancelUrl: process.env.PG_CALLBACK_CANCEL_URL || 'https://unworshipping-kathrin-parablastic.ngrok-free.dev/api/v1/payments/pg/callback',
};

// ── SHA-512 Hash Generator ────────────────────────────────────────────────────
// Algorithm: toUpper(sha512(salt|val1|val2|...)) sorted alphabetically by key

function generateHash(params) {
  const sortedKeys = Object.keys(params).sort();
  let hashData = PG_CONFIG.salt;

  for (const key of sortedKeys) {
    const val = params[key];
    if (val !== null && val !== undefined && String(val).length > 0) {
      hashData += '|' + String(val).trim();
    }
  }

  return crypto
    .createHash('sha512')
    .update(hashData)
    .digest('hex')
    .toUpperCase();
}

// ── Verify Response Hash ──────────────────────────────────────────────────────

function verifyResponseHash(responseParams) {
  if (!responseParams.hash) return true; // null hash = skip check (per docs)

  const receivedHash = responseParams.hash;
  const paramsWithoutHash = { ...responseParams };
  delete paramsWithoutHash.hash;

  const calculatedHash = generateHash(paramsWithoutHash);
  const valid = receivedHash === calculatedHash;

  if (!valid) {
    logger.error(`[PG] Hash mismatch! Received: ${receivedHash} | Calculated: ${calculatedHash}`);
  }

  return valid;
}

// ── Build Payment Request Params ──────────────────────────────────────────────

function buildPaymentRequest({ orderRef, amount, user }) {
  const params = {
    api_key:            PG_CONFIG.apiKey,
    order_id:           orderRef,
    mode:               PG_CONFIG.mode,
    amount:             parseFloat(amount).toFixed(2),
    currency:           'INR',
    description:        'Wallet Recharge - Speedonet',
    name:               user.name     || 'User',
    email:              user.email    || 'user@speedonet.in',
    phone:              user.phone    || '9999999999',
    city:               user.city     || 'Mumbai',
    state:              user.state    || 'Maharashtra',
    country:            'IND',
    zip_code:           user.zip_code || '400001',
    return_url:         PG_CONFIG.callbackUrl,
    return_url_failure: PG_CONFIG.callbackFailUrl,
    return_url_cancel:  PG_CONFIG.callbackCancelUrl,
  };

  params.hash = generateHash(params);

  return {
    params,
    paymentUrl: `https://${PG_CONFIG.pgApiUrl}/v2/paymentrequest`,
  };
}

// ── Get Two-Step Payment URL (recommended for mobile apps) ───────────────────

async function getPaymentUrl({ orderRef, amount, user }) {
  const params = {
    api_key:            PG_CONFIG.apiKey,
    order_id:           orderRef,
    mode:               PG_CONFIG.mode,
    amount:             parseFloat(amount).toFixed(2),
    currency:           'INR',
    description:        'Wallet Recharge - Speedonet',
    name:               user.name     || 'User',
    email:              user.email    || 'user@speedonet.in',
    phone:              user.phone    || '9999999999',
    city:               user.city     || 'Mumbai',
    state:              user.state    || 'Maharashtra',
    country:            'IND',
    zip_code:           user.zip_code || '400001',
    return_url:         PG_CONFIG.callbackUrl,
    return_url_failure: PG_CONFIG.callbackFailUrl,
    return_url_cancel:  PG_CONFIG.callbackCancelUrl,
    expiry_in_minutes:  '30',
  };

  params.hash = generateHash(params);

  const form = new URLSearchParams(params);

  const response = await axios.post(
    `https://${PG_CONFIG.pgApiUrl}/v2/getpaymentrequesturl`,
    form.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (response.data?.error) {
    throw Object.assign(
      new Error(response.data.error.message || 'Failed to get payment URL'),
      { statusCode: 400 }
    );
  }

  return response.data.data; // { url, uuid, expiry_datetime, order_id }
}

// ── Process Callback (POST from Payment Gateway) ──────────────────────────────

function processCallback(body) {
  logger.info(`[PG] Callback received: ${JSON.stringify(body)}`);

  const {
    transaction_id,
    order_id,
    response_code,
    response_message,
    amount,
    payment_mode,
    payment_channel,
    hash,
    ...rest
  } = body;

  if (!verifyResponseHash(body)) {
    throw Object.assign(
      new Error('Hash verification failed — possible tampering'),
      { statusCode: 400 }
    );
  }

  const success = String(response_code) === '0';

  logger.info(
    `[PG] Callback | order=${order_id} txn=${transaction_id} ` +
    `status=${response_code} success=${success}`
  );

  return {
    success,
    orderRef:      order_id,
    transactionId: transaction_id,
    amount,
    responseCode:  response_code,
    responseMsg:   response_message,
    paymentMode:   payment_mode,
    paymentChannel: payment_channel,
    raw:           body,
  };
}

// ── Check Payment Status via API ──────────────────────────────────────────────

async function checkPaymentStatus(orderRef) {
  const params = {
    api_key:  PG_CONFIG.apiKey,
    order_id: orderRef,
  };

  params.hash = generateHash(params);

  const form = new URLSearchParams(params);

  const response = await axios.post(
    `https://${PG_CONFIG.pgApiUrl}/v2/paymentstatus`,
    form.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return response.data;
}

module.exports = {
  generateHash,
  verifyResponseHash,
  buildPaymentRequest,
  getPaymentUrl,
  processCallback,
  checkPaymentStatus,
  PG_CONFIG,
};
