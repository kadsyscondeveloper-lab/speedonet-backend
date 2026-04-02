// services/planService.js

const { db, sql }                         = require('../config/db');
const { generateOrderRef }                = require('../utils/helpers');
const { validateCoupon, recordCouponUse } = require('./couponService');
const notifyUser                          = require('../utils/notifyUser');

// ── Plans catalogue ───────────────────────────────────────────────────────────





async function activatePendingSubscription(dbOrTrx, userId) {
  const sub = await dbOrTrx
    .selectFrom('dbo.user_subscriptions as s')
    .innerJoin('dbo.broadband_plans as p', 'p.id', 's.plan_id')
    .select(['s.id', 'p.validity_days', 'p.name as plan_name'])
    .where('s.user_id', '=', BigInt(userId))
    .where('s.status',  '=', 'pending_installation')
    .top(1)
    .executeTakeFirst();
 
  if (!sub) return null;
 
  const toDate    = (d) => d.toISOString().slice(0, 10);
  const startDate = new Date();
  const expiresAt = new Date(startDate.getTime() + sub.validity_days * 86_400_000);
 
  await dbOrTrx
    .updateTable('dbo.user_subscriptions')
    .set({
      status:     'active',
      start_date: new Date(toDate(startDate)),
      expires_at: new Date(toDate(expiresAt)),
    })
    .where('id', '=', sub.id)
    .execute();
 
  return { id: sub.id, plan_name: sub.plan_name, startDate, expiresAt };
}



async function getAllPlans() {
  return db
    .selectFrom('dbo.broadband_plans')
    .select(['id', 'name', 'price', 'speed_mbps', 'data_limit', 'validity_days', 'category'])
    .where('is_active', '=', true)
    .orderBy('sort_order', 'asc')
    .orderBy('price', 'asc')
    .execute();
}

async function getPlanById(planId) {
  return (
    (await db
      .selectFrom('dbo.broadband_plans')
      .select(['id', 'name', 'price', 'speed_mbps', 'data_limit', 'validity_days', 'category'])
      .where('id',        '=', planId)
      .where('is_active', '=', true)
      .executeTakeFirst()) ?? null
  );
}

// ── Plan purchase ─────────────────────────────────────────────────────────────

async function purchasePlan(userId, planId, paymentMode = 'wallet', couponCode = null) {
  const plan = await getPlanById(planId);
  if (!plan)
    throw Object.assign(new Error('Plan not found or inactive.'), { statusCode: 404 });
 
  const userRow = await db
    .selectFrom('dbo.users')
    .select(['id', 'wallet_balance'])
    .where('id', '=', BigInt(userId))
    .executeTakeFirst();
 
  if (!userRow)
    throw Object.assign(new Error('User not found.'), { statusCode: 404 });
 
  // ── NEW: block if a plan is already waiting for installation ──────────────
  const pendingInstallSub = await db                                         // ← CHANGED
    .selectFrom('dbo.user_subscriptions')
    .select('id')
    .where('user_id', '=', BigInt(userId))
    .where('status',  '=', 'pending_installation')
    .top(1)
    .executeTakeFirst();
 
  if (pendingInstallSub)
    throw Object.assign(
      new Error(
        'You already have a plan waiting to activate after your installation is complete. ' +
        'Please wait for your router to be installed.'
      ),
      { statusCode: 400 }
    );
 
  // ── Guard: block if a queued plan already exists ──────────────────────────
  const queuedSub = await db
    .selectFrom('dbo.user_subscriptions')
    .select('id')
    .where('user_id',    '=', BigInt(userId))
    .where('status',     '=', 'active')
    .where('start_date', '>',  sql`CAST(SYSDATETIME() AS DATE)`)
    .top(1)
    .executeTakeFirst();
 
  if (queuedSub)
    throw Object.assign(
      new Error('You already have a plan queued for your next cycle. You can only queue one plan at a time.'),
      { statusCode: 400 }
    );
 
  // ── Guard: enforce the 2-day renewal window ───────────────────────────────
  const activeSub = await db
    .selectFrom('dbo.user_subscriptions')
    .select('expires_at')
    .where('user_id',    '=', BigInt(userId))
    .where('status',     '=', 'active')
    .where('expires_at', '>=', sql`CAST(SYSDATETIME() AS DATE)`)
    .orderBy('expires_at', 'desc')
    .top(1)
    .executeTakeFirst();
 
  if (activeSub) {
    const now           = new Date();
    const expiry        = new Date(activeSub.expires_at);
    const daysRemaining = (expiry - now) / (1000 * 60 * 60 * 24);
 
    if (daysRemaining > 2) {
      const expiryStr = expiry.toDateString();
      throw Object.assign(
        new Error(
          `Your current plan is active until ${expiryStr}. ` +
          `You can purchase your next plan within 2 days of expiry.`
        ),
        { statusCode: 400 }
      );
    }
  }
 
  // ── Pricing ───────────────────────────────────────────────────────────────
  const baseAmount = parseFloat(plan.price);
  const gstAmount  = parseFloat((baseAmount * 0.18).toFixed(2));
  const subtotal   = parseFloat((baseAmount + gstAmount).toFixed(2));
 
  // ── Coupon ────────────────────────────────────────────────────────────────
  let couponId = null, couponData = null, discountAmount = 0;
 
  if (couponCode && couponCode.trim()) {
    const result = await validateCoupon(couponCode.trim(), userId, subtotal);
    if (!result.valid)
      throw Object.assign(new Error(result.error), { statusCode: 400, couponError: true });
    couponId       = result.coupon.id;
    couponData     = result.coupon;
    discountAmount = result.discount;
  }
 
  const totalAmount   = parseFloat((subtotal - discountAmount).toFixed(2));
  const walletBalance = parseFloat(userRow.wallet_balance);
 
  if (paymentMode === 'wallet' && walletBalance < totalAmount)
    throw Object.assign(
      new Error(`Insufficient wallet balance. Required ₹${totalAmount.toFixed(2)}, available ₹${walletBalance.toFixed(2)}.`),
      { statusCode: 400 }
    );
 
  const orderRef = generateOrderRef();
 
  // ── NEW: check if user has a completed installation already ──────────────  // ← CHANGED
  const completedInstall = await db
    .selectFrom('dbo.installation_requests')
    .select('id')
    .where('user_id', '=', BigInt(userId))
    .where('status',  '=', 'completed')
    .top(1)
    .executeTakeFirst();
 
  const hasInstallation = !!completedInstall;
 
  // For renewal purchases (installation already done), use the old queued logic.
  // For first-time buyers, the plan is deferred until installation completes.
  const startDate = hasInstallation && activeSub
    ? new Date(activeSub.expires_at)
    : hasInstallation
      ? new Date()
      : null;  // ← CHANGED: null until installation
 
  const expiresAt = startDate
    ? new Date(startDate.getTime() + plan.validity_days * 86_400_000)
    : null;  // ← CHANGED: null until installation
 
  const toDate        = (d) => d ? d.toISOString().slice(0, 10) : null;
  const todayStr      = toDate(new Date());
  const startDateStr  = toDate(startDate);
  // A plan is "queued" only when it has a real start date in the future
  const isQueued      = startDateStr && startDateStr > todayStr;
  // A plan is "pending installation" when no installation is done yet
  const isPendingInstall = !hasInstallation;  // ← CHANGED
 
  const subStatus = isPendingInstall ? 'pending_installation'  // ← CHANGED
    : 'active';
 
  const balanceAfter = parseFloat((walletBalance - totalAmount).toFixed(2));
 
  return db.transaction().execute(async (trx) => {
    // 1. Payment order
    const orderRow = await trx
      .insertInto('dbo.payment_orders')
      .values({
        user_id:         BigInt(userId),
        order_ref:       orderRef,
        type:            'broadband_plan',
        plan_id:         planId,
        base_amount:     String(baseAmount),
        gst_amount:      String(gstAmount),
        discount_amount: String(discountAmount),
        total_amount:    String(totalAmount),
        payment_method:  paymentMode,
        payment_status:  'pending',
        gateway_name:    'wallet',
        coupon_id:       couponId,
        coupon_code:     couponData?.code ?? null,
      })
      .output(['inserted.id'])
      .executeTakeFirstOrThrow();
 
    const orderId = orderRow.id;
 
    // 2. Re-read wallet with row lock
    const fresh = await sql`
      SELECT wallet_balance FROM dbo.users WITH (UPDLOCK, ROWLOCK)
      WHERE id = ${BigInt(userId)}
    `.execute(trx).then(r => r.rows[0]);
 
    if (paymentMode === 'wallet' && parseFloat(fresh.wallet_balance) < totalAmount)
      throw Object.assign(
        new Error(`Insufficient wallet balance. Required ₹${totalAmount.toFixed(2)}.`),
        { statusCode: 400 }
      );
 
    // 3. Deduct wallet
    await trx
      .updateTable('dbo.users')
      .set({ wallet_balance: sql`wallet_balance - ${totalAmount}`, updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', BigInt(userId))
      .execute();
 
    // 4. Wallet debit transaction
    const description = discountAmount > 0
      ? `Plan purchase: ${plan.name} (incl. GST · coupon ${couponData.code} saved ₹${discountAmount.toFixed(2)})`
      : `Plan purchase: ${plan.name} (incl. GST)`;
 
    await trx
      .insertInto('dbo.wallet_transactions')
      .values({
        user_id:        BigInt(userId),
        type:           'debit',
        amount:         String(totalAmount),
        balance_after:  String(balanceAfter),
        description,
        reference_id:   String(orderId),
        reference_type: 'payment_order',
      })
      .execute();
 
    // 5. Subscription — ← CHANGED: status and dates depend on installation
    const subRow = await trx
      .insertInto('dbo.user_subscriptions')
      .values({
        user_id:      BigInt(userId),
        plan_id:      planId,
        order_id:     orderId,
        status:       subStatus,                                     // ← CHANGED
        start_date:   startDate ? new Date(toDate(startDate)) : null, // ← CHANGED
        expires_at:   expiresAt ? new Date(toDate(expiresAt)) : null, // ← CHANGED
        data_used_gb: '0',
      })
      .output(['inserted.id'])
      .executeTakeFirstOrThrow();
 
    // 6. Mark order success
    await trx
      .updateTable('dbo.payment_orders')
      .set({ payment_status: 'success', paid_at: sql`SYSUTCDATETIME()`, updated_at: sql`SYSUTCDATETIME()` })
      .where('id', '=', orderId)
      .execute();
 
    // 7. Bill
    await trx
      .insertInto('dbo.bills')
      .values({
        user_id:              BigInt(userId),
        plan_id:              planId,
        bill_number:          `INV-${Date.now()}-${orderRef.slice(-6)}`,
        billing_period_start: startDate ? new Date(toDate(startDate)) : null, // ← CHANGED
        billing_period_end:   expiresAt ? new Date(toDate(expiresAt)) : null, // ← CHANGED
        base_amount:          String(baseAmount),
        gst_amount:           String(gstAmount),
        total_amount:         String(totalAmount),
        due_date:             expiresAt ? new Date(toDate(expiresAt)) : null, // ← CHANGED
        status:               'paid',
        paid_via_order:       orderId,
        paid_at:              sql`SYSUTCDATETIME()`,
      })
      .execute();
 
    // 8. Notification — ← CHANGED: message reflects pending install state
    const notifBody = isPendingInstall
      ? `Your ${plan.name} plan is paid and ready. It will activate automatically once your router is installed.`
      : isQueued
        ? `Your ${plan.name} plan is queued and starts on ${startDate.toDateString()}.`
        : discountAmount > 0
          ? `Your ${plan.name} plan is active until ${expiresAt.toDateString()}. 🎉 Coupon ${couponData.code} saved you ₹${discountAmount.toFixed(2)}!`
          : `Your ${plan.name} plan is active until ${expiresAt.toDateString()}. Enjoy ${plan.speed_mbps} Mbps!`;
 
    await notifyUser(trx, userId, {
      type:  'plan_activated',
      title: isPendingInstall
        ? 'Plan Purchased — Awaiting Installation 🔧'  // ← CHANGED
        : isQueued
          ? 'Plan Queued 🗓️'
          : discountAmount > 0
            ? 'Plan Activated + Discount Applied 🎉'
            : 'Plan Activated 🎉',
      body: notifBody,
      data: { plan_name: plan.name, order_ref: orderRef },
    });
 
    // 9. Coupon + referral reward (unchanged)
    if (couponId) {
      await recordCouponUse(trx, { couponId, userId, orderId, discountApplied: discountAmount });
 
      const referralRow = await trx
        .selectFrom('dbo.referrals')
        .select(['id', 'referrer_id'])
        .where('referred_id', '=', BigInt(userId))
        .where('status',      '=', 'pending')
        .executeTakeFirst();
 
      if (referralRow) {
        const REFERRAL_REWARD = 50;
 
        await trx
          .updateTable('dbo.referrals')
          .set({ status: 'rewarded', referrer_reward: String(REFERRAL_REWARD) })
          .where('id', '=', referralRow.id)
          .execute();
 
        const referrerRow = await trx
          .selectFrom('dbo.users')
          .select('wallet_balance')
          .where('id', '=', referralRow.referrer_id)
          .executeTakeFirst();
 
        const referrerCurrentBalance = parseFloat(referrerRow?.wallet_balance ?? '0');
        const referrerBalanceAfter   = parseFloat((referrerCurrentBalance + REFERRAL_REWARD).toFixed(2));
 
        await trx
          .updateTable('dbo.users')
          .set({ wallet_balance: sql`wallet_balance + ${REFERRAL_REWARD}`, updated_at: sql`SYSUTCDATETIME()` })
          .where('id', '=', referralRow.referrer_id)
          .execute();
 
        await trx
          .insertInto('dbo.wallet_transactions')
          .values({
            user_id:        referralRow.referrer_id,
            type:           'credit',
            amount:         String(REFERRAL_REWARD),
            balance_after:  String(referrerBalanceAfter),
            description:    `Referral reward — your referral activated their first plan`,
            reference_id:   String(orderId),
            reference_type: 'referral',
          })
          .execute();
 
        await notifyUser(trx, referralRow.referrer_id, {
          type:  'referral_rewarded',
          title: 'Referral Reward Unlocked 🎁',
          body:  `₹${REFERRAL_REWARD} has been added to your wallet! Someone you referred just activated their first Speedonet plan.`,
          data:  { amount: String(REFERRAL_REWARD) },
        });
      }
    }
 
    return {
      subscription_id:        subRow.id,
      order_id:               orderId,
      order_ref:              orderRef,
      plan,
      start_date:             startDate,
      expires_at:             expiresAt,
      amount_paid:            totalAmount,
      base_amount:            baseAmount,
      gst_amount:             gstAmount,
      discount_applied:       discountAmount,
      coupon_code:            couponData?.code ?? null,
      is_queued:              isQueued,
      is_pending_installation: isPendingInstall,  // ← CHANGED: Flutter uses this
      status:                 subStatus,
    };
  });
}

// ── Coupon pre-validation ─────────────────────────────────────────────────────

async function validateCouponForPlan(userId, planId, couponCode) {
  const plan = await getPlanById(planId);
  if (!plan) throw Object.assign(new Error('Plan not found.'), { statusCode: 404 });

  const baseAmount = parseFloat(plan.price);
  const gstAmount  = parseFloat((baseAmount * 0.18).toFixed(2));
  const subtotal   = parseFloat((baseAmount + gstAmount).toFixed(2));

  const result = await validateCoupon(couponCode, userId, subtotal);
  if (!result.valid) throw Object.assign(new Error(result.error), { statusCode: 400 });

  return {
    valid:           true,
    code:            result.coupon.code,
    description:     result.coupon.description,
    discount_type:   result.coupon.discountType,
    discount_value:  result.coupon.discountValue,
    discount_amount: result.discount,
    original_total:  subtotal,
    final_total:     parseFloat((subtotal - result.discount).toFixed(2)),
  };
}

// ── Active subscription ───────────────────────────────────────────────────────

async function getActiveSubscription(userId) {
  return (
    (await db
      .selectFrom('dbo.user_subscriptions as s')
      .innerJoin('dbo.broadband_plans as p',  'p.id',  's.plan_id')
      .innerJoin('dbo.payment_orders as po',  'po.id', 's.order_id')
      .select([
        's.id as subscription_id', 's.status', 's.start_date', 's.expires_at',
        'po.order_ref', 'po.total_amount as amount_paid',
        'p.id as plan_id', 'p.name as plan_name', 'p.speed_mbps',
        'p.data_limit', 'p.validity_days', 'p.price',
      ])
      .where('s.user_id',    '=', BigInt(userId))
      .where('s.status',     '=', 'active')
      .where('s.start_date', '<=', sql`CAST(SYSDATETIME() AS DATE)`)
      .where('s.expires_at', '>=', sql`CAST(SYSDATETIME() AS DATE)`)
      .orderBy('s.expires_at', 'desc')
      .top(1)
      .executeTakeFirst()) ?? null
  );
}

// ── Queued subscription ───────────────────────────────────────────────────────

async function getQueuedSubscription(userId) {
  return (
    (await db
      .selectFrom('dbo.user_subscriptions as s')
      .innerJoin('dbo.broadband_plans as p',  'p.id',  's.plan_id')
      .innerJoin('dbo.payment_orders as po',  'po.id', 's.order_id')
      .select([
        's.id as subscription_id', 's.status', 's.start_date', 's.expires_at',
        'po.order_ref', 'po.total_amount as amount_paid',
        'p.id as plan_id', 'p.name as plan_name', 'p.speed_mbps',
        'p.data_limit', 'p.validity_days', 'p.price',
      ])
      .where('s.user_id',    '=', BigInt(userId))
      .where('s.status',     '=', 'active')
      .where('s.start_date', '>',  sql`CAST(SYSDATETIME() AS DATE)`)
      .orderBy('s.start_date', 'asc')
      .top(1)
      .executeTakeFirst()) ?? null
  );
}

// ── Subscription history ──────────────────────────────────────────────────────

async function getSubscriptionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;
  const [rows, countRow] = await Promise.all([
    sql`
      SELECT s.id, s.status, s.start_date, s.expires_at,
             p.name AS plan_name, p.speed_mbps, p.data_limit,
             po.order_ref, po.total_amount AS amount_paid
      FROM dbo.user_subscriptions s
      INNER JOIN dbo.broadband_plans p  ON p.id  = s.plan_id
      INNER JOIN dbo.payment_orders  po ON po.id = s.order_id
      WHERE s.user_id = ${BigInt(userId)}
      ORDER BY s.created_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows),
    db.selectFrom('dbo.user_subscriptions')
      .select(db.fn.count('id').as('total'))
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);
  return { subscriptions: rows, total: Number(countRow.total) };
}

// ── Transaction history ───────────────────────────────────────────────────────

async function getTransactionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;
  const [rows, countRow] = await Promise.all([
    sql`
      SELECT wt.id, wt.type, wt.amount, wt.balance_after, wt.description,
             wt.reference_id, wt.reference_type, wt.created_at,
             po.order_ref, po.payment_status, po.discount_amount, po.coupon_code,
             p.name AS plan_name
      FROM dbo.wallet_transactions wt
      LEFT JOIN dbo.payment_orders po
             ON po.id = TRY_CAST(wt.reference_id AS BIGINT)
            AND wt.reference_type IN ('payment_order', 'wallet_recharge')
      LEFT JOIN dbo.broadband_plans p ON p.id = po.plan_id
      WHERE wt.user_id = ${BigInt(userId)}
      ORDER BY wt.created_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows),
    db.selectFrom('dbo.wallet_transactions')
      .select(db.fn.count('id').as('total'))
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);
  return { transactions: rows, total: Number(countRow.total) };
}

module.exports = {
  getAllPlans,
  getPlanById,
  purchasePlan,
  validateCouponForPlan,
  getActiveSubscription,
  getQueuedSubscription,
  getSubscriptionHistory,
  getTransactionHistory,
  activatePendingSubscription,
};