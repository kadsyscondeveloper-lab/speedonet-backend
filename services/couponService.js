/**
 * services/couponService.js
 *
 * Changes vs previous version:
 *  1. validateCoupon  — first_purchase_only check: .limit(1) → .top(1)  [MSSQL fix]
 *  2. listCoupons     — replaced .limit().offset() with raw OFFSET/FETCH  [MSSQL fix]
 *  3. generateReferralCoupon — no change, kept as-is (was never called; wired up in authController)
 */

const { db, sql } = require('../config/db');

// ── Validate a coupon for a given user + order amount ─────────────────────────

async function validateCoupon(code, userId, orderAmount) {
  if (!code || !code.trim()) {
    return { valid: false, error: 'Please enter a coupon code.' };
  }

  const coupon = await db
    .selectFrom('dbo.coupons')
    .selectAll()
    .where('code',      '=', code.trim().toUpperCase())
    .where('is_active', '=', true)
    .executeTakeFirst();

  if (!coupon) {
    return { valid: false, error: 'Invalid coupon code.' };
  }

  // Expiry
  const now = new Date();
  if (now < new Date(coupon.valid_from) || now > new Date(coupon.valid_to)) {
    return { valid: false, error: 'This coupon has expired.' };
  }

  // Usage cap
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
    return { valid: false, error: 'This coupon has reached its usage limit.' };
  }

  // User-specific
  if (coupon.user_id !== null && BigInt(coupon.user_id) !== BigInt(userId)) {
    return { valid: false, error: 'This coupon is not valid for your account.' };
  }

  // First purchase only
  if (coupon.first_purchase_only) {
    // ── FIXED: .limit(1) → .top(1) for SQL Server ────────────────────────
    const prev = await db
      .selectFrom('dbo.payment_orders')
      .select('id')
      .where('user_id',        '=', BigInt(userId))
      .where('type',           '=', 'broadband_plan')
      .where('payment_status', '=', 'success')
      .top(1)
      .executeTakeFirst();
    // ─────────────────────────────────────────────────────────────────────
    if (prev) {
      return {
        valid: false,
        error: 'This coupon is only valid on your first plan purchase.',
      };
    }
  }

  // Already used by this user
  const alreadyUsed = await db
    .selectFrom('dbo.coupon_uses')
    .select('id')
    .where('coupon_id', '=', coupon.id)
    .where('user_id',   '=', BigInt(userId))
    .executeTakeFirst();

  if (alreadyUsed) {
    return { valid: false, error: 'You have already used this coupon.' };
  }

  // Minimum order amount
  if (orderAmount < parseFloat(coupon.min_order_amount)) {
    return {
      valid: false,
      error: `Minimum order amount of ₹${parseFloat(coupon.min_order_amount).toFixed(0)} required.`,
    };
  }

  const discount = calculateDiscount(coupon, orderAmount);

  return {
    valid: true,
    coupon: {
      id:            coupon.id,
      code:          coupon.code,
      description:   coupon.description,
      discountType:  coupon.discount_type,
      discountValue: parseFloat(coupon.discount_value),
      maxDiscount:   coupon.max_discount_amount
        ? parseFloat(coupon.max_discount_amount)
        : null,
    },
    discount,
  };
}

// ── Discount calculation ──────────────────────────────────────────────────────

function calculateDiscount(coupon, orderAmount) {
  let discount = 0;

  if (coupon.discount_type === 'percent') {
    discount = (orderAmount * parseFloat(coupon.discount_value)) / 100;
    if (coupon.max_discount_amount) {
      discount = Math.min(discount, parseFloat(coupon.max_discount_amount));
    }
  } else {
    discount = parseFloat(coupon.discount_value);
  }

  return parseFloat(Math.min(discount, orderAmount).toFixed(2));
}

// ── Record coupon use (called inside planService transaction) ─────────────────

async function recordCouponUse(trx, { couponId, userId, orderId, discountApplied }) {
  await trx
    .insertInto('dbo.coupon_uses')
    .values({
      coupon_id:        couponId,
      user_id:          BigInt(userId),
      order_id:         orderId,
      discount_applied: String(discountApplied),
    })
    .execute();

  await trx
    .updateTable('dbo.coupons')
    .set({ used_count: sql`used_count + 1` })
    .where('id', '=', couponId)
    .execute();
}

// ── Generate a referral coupon for the newly-signed-up user ──────────────────
// Called by authController right after applyReferral().

async function generateReferralCoupon(newUserId) {
  const suffix = String(newUserId).slice(-4).padStart(4, '0');
  const random = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0');
  const code = `REF${suffix}${random}`;

  const validFrom = new Date();
  const validTo   = new Date(validFrom.getTime() + 30 * 86_400_000); // 30 days

  await db
    .insertInto('dbo.coupons')
    .values({
      code,
      description:         '20% off your first Speedonet plan (referral reward)',
      discount_type:       'percent',
      discount_value:      '20',
      max_discount_amount: '500',
      min_order_amount:    '0',
      max_uses:            1,
      valid_from:          validFrom,
      valid_to:            validTo,
      first_purchase_only: true,
      is_active:           true,
      user_id:             BigInt(newUserId),
    })
    .execute();

  return code;
}

// ── Admin helper: create coupon ───────────────────────────────────────────────

async function createCoupon({
  code,
  description,
  discountType,
  discountValue,
  maxDiscountAmount = null,
  minOrderAmount    = 0,
  maxUses           = null,
  validFrom,
  validTo,
  firstPurchaseOnly = false,
  userId            = null,
}) {
  await db
    .insertInto('dbo.coupons')
    .values({
      code:                code.toUpperCase(),
      description,
      discount_type:       discountType,
      discount_value:      String(discountValue),
      max_discount_amount: maxDiscountAmount ? String(maxDiscountAmount) : null,
      min_order_amount:    String(minOrderAmount),
      max_uses:            maxUses,
      valid_from:          new Date(validFrom),
      valid_to:            new Date(validTo),
      first_purchase_only: firstPurchaseOnly,
      is_active:           true,
      user_id:             userId ? BigInt(userId) : null,
    })
    .execute();
}

// ── Admin helper: list coupons ────────────────────────────────────────────────
// FIXED: replaced .limit().offset() with OFFSET/FETCH raw SQL for SQL Server.

async function listCoupons({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const result = await sql`
    SELECT *
    FROM   dbo.coupons
    ORDER  BY created_at DESC
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `.execute(db);
  return result.rows;
}

module.exports = {
  validateCoupon,
  calculateDiscount,
  recordCouponUse,
  generateReferralCoupon,
  createCoupon,
  listCoupons,
};