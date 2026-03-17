// services/gatewayService.js
//
// ── Payment Gateway Router ────────────────────────────────────────────────────
//
// Routes payment requests to either:
//   - Omniware (pgbiz.omniware.in)  → PAYMENT_GATEWAY=omniware  (default / live)
//   - Atom UAT (caller.atomtech.in) → PAYMENT_GATEWAY=atom      (testing)
//
// Usage in .env:
//   PAYMENT_GATEWAY=omniware   ← production
//   PAYMENT_GATEWAY=atom       ← UAT testing
// ─────────────────────────────────────────────────────────────────────────────

const pgService   = require('./pgPaymentService');
const atomService = require('./atomPaymentService');
const logger      = require('../utils/logger');

function getActiveGateway() {
  return (process.env.PAYMENT_GATEWAY || 'omniware').toLowerCase();
}

function isAtom() {
  return getActiveGateway() === 'atom';
}

function isOmniware() {
  return getActiveGateway() === 'omniware';
}

/**
 * Initiate a payment URL.
 * [gatewayOverride] — pass 'atom' or 'omniware' to override env setting.
 * Returns unified shape regardless of gateway.
 */
async function initiatePayment({ orderRef, amount, user, gatewayOverride }) {
  const gateway = gatewayOverride || getActiveGateway();
  logger.info(`[Gateway] Using: ${gateway.toUpperCase()} | orderRef=${orderRef} amt=${amount}`);

  if (gateway === 'atom') {
    const amtString = parseFloat(amount).toFixed(2);
    const { atomUrl, encData, ru, login } = await atomService.initiatePayment({
      txnid:      orderRef,
      amt:        amtString,
      custEmail:  user?.email  || '',
      custMobile: user?.phone  || '',
    });

    return {
      gateway:    'atom',
      paymentUrl: atomUrl,
      orderRef,
      amount:     amtString,
      // User info for Atom SDK
      custName:   user?.name   || '',
      custEmail:  user?.email  || '',
      custMobile: user?.phone  || '',
    };
  }

  // Default: Omniware two-step URL
  const pgData = await pgService.getPaymentUrl({ orderRef, amount, user });
  return {
    gateway:    'omniware',
    paymentUrl: pgData.url,
    orderRef,
    amount:     parseFloat(amount).toFixed(2),
    uuid:       pgData.uuid,
    expiresAt:  pgData.expiry_datetime,
  };
}

/**
 * Process a callback from either gateway.
 * Returns unified { success, orderRef, transactionId, amount, responseCode }
 */
async function processCallback(body, gatewayHint) {
  const gateway = gatewayHint || _detectGateway(body);
  logger.info(`[Gateway] Processing callback | gateway=${gateway}`);

  if (gateway === 'atom') {
    const result = await atomService.processCallback(body);
    return {
      success:       result.success,
      orderRef:      result.txnid,
      transactionId: result.atomtxnId || result.bankTxnId,
      amount:        result.amt,
      responseCode:  result.txnStatus === 'Ok' ? '0' : '1',
      raw:           result.params,
    };
  }

  // Omniware
  const result = pgService.processCallback(body);
  return {
    success:       result.success,
    orderRef:      result.orderRef,
    transactionId: result.transactionId,
    amount:        result.amount,
    responseCode:  result.responseCode,
    raw:           result.raw,
  };
}

/**
 * Auto-detect gateway from callback body shape.
 * Atom callbacks have encData, Omniware have response_code + order_id.
 */
function _detectGateway(body) {
  if (body?.encData || body?.encdata || body?.EncData) return 'atom';
  if (body?.response_code !== undefined)               return 'omniware';
  return getActiveGateway(); // fallback to env setting
}

module.exports = {
  getActiveGateway,
  isAtom,
  isOmniware,
  initiatePayment,
  processCallback,
};