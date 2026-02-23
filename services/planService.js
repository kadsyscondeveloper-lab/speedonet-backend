/**
 * services/planService.js
 * Kysely rewrite — identical exports to the original so controllers need no changes.
 *
 * KEY FIX: purchasePlan is now wrapped in a DB transaction.
 * In the original, if the subscription INSERT failed after the wallet was
 * already debited, money was gone with no plan activated. That bug is fixed here.
 */

const { db, sql } = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');

// ── Plans Catalogue ───────────────────────────────────────────────────────────

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
  const row = await db
    .selectFrom('dbo.broadband_plans')
    .select(['id', 'name', 'price', 'speed_mbps', 'data_limit', 'validity_days', 'category'])
    .where('id',        '=', planId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  return row ?? null;
}

// ── Plan Purchase ─────────────────────────────────────────────────────────────

async function purchasePlan(userId, planId, paymentMode = 'wallet') {

  // ── Pre-flight checks (reads, safe outside transaction) ───────────────────

  const plan = await getPlanById(planId);
  if (!plan) {
    throw Object.assign(new Error('Plan not found or inactive.'), { statusCode: 404 });
  }

  const userRow = await db
    .selectFrom('dbo.users')
    .select(['id', 'wallet_balance'])
    .where('id', '=', BigInt(userId))
    .executeTakeFirst();

  if (!userRow) {
    throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  }

  const walletBalance = parseFloat(userRow.wallet_balance);
  const planPrice     = parseFloat(plan.price);
  const baseAmount    = planPrice;
  const gstAmount     = parseFloat((baseAmount * 0.18).toFixed(2));
  const totalAmount   = parseFloat((baseAmount + gstAmount).toFixed(2));

  if (paymentMode === 'wallet' && walletBalance < totalAmount) {
    throw Object.assign(
      new Error(`Insufficient wallet balance. Required ₹${totalAmount.toFixed(2)}, available ₹${walletBalance.toFixed(2)}.`),
      { statusCode: 400 },
    );
  }

  const orderRef     = generateOrderRef();
  const startDate    = new Date();
  const expiresAt    = new Date(Date.now() + plan.validity_days * 86_400_000);
  const toDateStr    = (d) => d.toISOString().slice(0, 10);
  const balanceAfter = parseFloat((walletBalance - totalAmount).toFixed(2));

  // ── Transaction — all steps succeed or all roll back ─────────────────────

  return db.transaction().execute(async (trx) => {

    // 1. Insert payment order (pending)
    const orderRow = await trx
      .insertInto('dbo.payment_orders')
      .values({
        user_id:          BigInt(userId),
        order_ref:        orderRef,
        type:             'broadband_plan',
        plan_id:          planId,
        provider_id:      null,
        base_amount:      String(baseAmount),
        gst_amount:       String(gstAmount),
        discount_amount:  '0',
        total_amount:     String(totalAmount),
        payment_method:   paymentMode,
        payment_status:   'pending',
        gateway_name:     'wallet',
        gateway_order_id: null,
        gateway_txn_id:   null,
      })
      .output(['inserted.id'])
      .executeTakeFirstOrThrow();

    const orderId = orderRow.id;

    // 2. Re-read wallet balance inside the transaction with a row lock
    //    to guard against two simultaneous purchases draining the wallet
    const freshUser = await sql`
  SELECT wallet_balance
  FROM dbo.users WITH (UPDLOCK, ROWLOCK)
  WHERE id = ${BigInt(userId)}
`.execute(trx).then(r => r.rows[0]);

    const freshBalance = parseFloat(freshUser.wallet_balance);
    if (paymentMode === 'wallet' && freshBalance < totalAmount) {
      throw Object.assign(
        new Error(`Insufficient wallet balance. Required ₹${totalAmount.toFixed(2)}, available ₹${freshBalance.toFixed(2)}.`),
        { statusCode: 400 },
      );
    }

    // 3. Deduct wallet
    await trx
      .updateTable('dbo.users')
      .set({
        wallet_balance: sql`wallet_balance - ${totalAmount}`,
        updated_at:     sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', BigInt(userId))
      .execute();

    // 4. Record wallet debit
    await trx
      .insertInto('dbo.wallet_transactions')
      .values({
        user_id:        BigInt(userId),
        type:           'debit',
        amount:         String(totalAmount),
        balance_after:  String(balanceAfter),
        description:    `Plan purchase: ${plan.name} (incl. GST)`,
        reference_id:   String(orderId),
        reference_type: 'payment_order',
      })
      .execute();

    // 5. Create subscription
    const subRow = await trx
      .insertInto('dbo.user_subscriptions')
      .values({
        user_id:      BigInt(userId),
        plan_id:      planId,
        order_id:     orderId,
        status:       'active',
        start_date:   new Date(toDateStr(startDate)),
        expires_at:   new Date(toDateStr(expiresAt)),
        data_used_gb: '0',
      })
      .output(['inserted.id'])
      .executeTakeFirstOrThrow();

    // 6. Mark order as success
    await trx
      .updateTable('dbo.payment_orders')
      .set({
        payment_status: 'success',
        paid_at:        sql`SYSUTCDATETIME()`,
        updated_at:     sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', orderId)
      .execute();

    // 7. Activation notification
    await trx
      .insertInto('dbo.notifications')
      .values({
        user_id: BigInt(userId),
        type:    'plan_activated',
        title:   'Plan Activated 🎉',
        body:    `Your ${plan.name} plan is active until ${expiresAt.toDateString()}. Enjoy ${plan.speed_mbps} Mbps!`,
      })
      .execute();

    return {
      subscription_id: subRow.id,
      order_id:        orderId,
      order_ref:       orderRef,
      plan,
      start_date:      startDate,
      expires_at:      expiresAt,
      amount_paid:     totalAmount,
      status:          'active',
    };
  });
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

async function getActiveSubscription(userId) {
  const row = await db
    .selectFrom('dbo.user_subscriptions as s')
    .innerJoin('dbo.broadband_plans as p',  'p.id',  's.plan_id')
    .innerJoin('dbo.payment_orders as po',  'po.id', 's.order_id')
    .select([
      's.id as subscription_id',
      's.status', 's.start_date', 's.expires_at', 's.data_used_gb',
      'po.order_ref', 'po.total_amount as amount_paid', 'po.payment_method',
      'p.id as plan_id', 'p.name as plan_name', 'p.speed_mbps',
      'p.data_limit', 'p.validity_days', 'p.price', 'p.category',
    ])
    .where('s.user_id', '=', BigInt(userId))
    .where('s.status',  '=', 'active')
    .where('s.expires_at', '>=', sql`CAST(SYSDATETIME() AS DATE)`)
    .orderBy('s.expires_at', 'desc')
    .top(1)
    .executeTakeFirst();
  return row ?? null;
}

async function getSubscriptionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    db
      .selectFrom('dbo.user_subscriptions as s')
      .innerJoin('dbo.broadband_plans as p',  'p.id',  's.plan_id')
      .innerJoin('dbo.payment_orders as po',  'po.id', 's.order_id')
      .select([
        's.id as subscription_id', 's.status', 's.start_date',
        's.expires_at', 's.data_used_gb', 's.created_at',
        'po.order_ref', 'po.total_amount as amount_paid', 'po.payment_method',
        'p.name as plan_name', 'p.speed_mbps', 'p.data_limit',
        'p.validity_days', 'p.category',
      ])
      .where('s.user_id', '=', BigInt(userId))
      .orderBy('s.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute(),

    db
      .selectFrom('dbo.user_subscriptions')
      .select(db.fn.count('id').as('total'))
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);

  return { subscriptions: rows, total: Number(countRow.total) };
}

async function getTransactionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    sql`
      SELECT
        wt.id, wt.type, wt.amount, wt.balance_after,
        wt.description, wt.reference_id, wt.reference_type, wt.created_at,
        po.order_ref, po.payment_status,
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

    db
      .selectFrom('dbo.wallet_transactions')
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
  getActiveSubscription,
  getSubscriptionHistory,
  getTransactionHistory,
};