// services/planService.js
const { sql, query } = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');

// ─────────────────────────────────────────────────────────────────────────────
// Plans Catalogue
// ─────────────────────────────────────────────────────────────────────────────

async function getAllPlans() {
  const result = await query(
    `SELECT id, name, price, speed_mbps, data_limit, validity_days, category
     FROM dbo.broadband_plans
     WHERE is_active = 1
     ORDER BY sort_order ASC, price ASC`
  );
  return result.recordset;
}

async function getPlanById(planId) {
  const result = await query(
    `SELECT id, name, price, speed_mbps, data_limit, validity_days, category
     FROM dbo.broadband_plans
     WHERE id = @planId AND is_active = 1`,
    { planId: { type: sql.Int, value: planId } }
  );
  return result.recordset[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan Purchase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Purchase a plan via wallet balance.
 *
 * Flow:
 *   1. Validate plan exists and is active
 *   2. Validate user exists and has sufficient wallet balance
 *   3. Create payment_orders record (captures invoice details)
 *   4. Deduct wallet_balance on users
 *   5. Record wallet_transactions debit entry
 *   6. Create user_subscriptions linked to the order
 *   7. Mark payment_orders as success
 *   8. Fire activation notification
 */
async function purchasePlan(userId, planId, paymentMode = 'wallet') {
  // ── 1. Validate plan ────────────────────────────────────────────────────────
  const plan = await getPlanById(planId);
  if (!plan) {
    throw Object.assign(new Error('Plan not found or inactive.'), { statusCode: 404 });
  }

  // ── 2. Validate user + balance ──────────────────────────────────────────────
  const userResult = await query(
    `SELECT id, wallet_balance FROM dbo.users WHERE id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  const user = userResult.recordset[0];
  if (!user) {
    throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  }

  const walletBalance = parseFloat(user.wallet_balance);
  const planPrice     = parseFloat(plan.price);

  // GST calculation (18%)
  const gstRate     = 0.18;
  const baseAmount  = planPrice;
  const gstAmount   = parseFloat((baseAmount * gstRate).toFixed(2));
  const totalAmount = parseFloat((baseAmount + gstAmount).toFixed(2));

  if (paymentMode === 'wallet' && walletBalance < totalAmount) {
    throw Object.assign(
      new Error(
        `Insufficient wallet balance. Required ₹${totalAmount.toFixed(2)}, available ₹${walletBalance.toFixed(2)}.`
      ),
      { statusCode: 400 }
    );
  }

  const orderRef = generateOrderRef();

  // ── 3. Insert payment_orders ────────────────────────────────────────────────
  const orderResult = await query(
    `INSERT INTO dbo.payment_orders
       (user_id, order_ref, type, plan_id, provider_id,
        base_amount, gst_amount, discount_amount, total_amount,
        payment_method, payment_status,
        gateway_name, gateway_order_id, gateway_txn_id,
        created_at, updated_at)
     OUTPUT INSERTED.id
     VALUES
       (@userId, @orderRef, 'broadband_plan', @planId, NULL,
        @baseAmount, @gstAmount, 0, @totalAmount,
        @payMethod, 'pending',
        'wallet', NULL, NULL,
        SYSUTCDATETIME(), SYSUTCDATETIME())`,
    {
      userId:      { type: sql.BigInt,         value: userId      },
      orderRef:    { type: sql.NVarChar(64),   value: orderRef    },
      planId:      { type: sql.Int,            value: planId      },
      baseAmount:  { type: sql.Decimal(10, 2), value: baseAmount  },
      gstAmount:   { type: sql.Decimal(10, 2), value: gstAmount   },
      totalAmount: { type: sql.Decimal(10, 2), value: totalAmount },
      payMethod:   { type: sql.NVarChar(20),   value: paymentMode },
    }
  );

  const orderId = orderResult.recordset[0].id;

  // ── 4. Deduct wallet balance (totalAmount incl. GST) ────────────────────────
  await query(
    `UPDATE dbo.users
     SET wallet_balance = wallet_balance - @amount,
         updated_at     = SYSUTCDATETIME()
     WHERE id = @userId`,
    {
      amount: { type: sql.Decimal(10, 2), value: totalAmount },
      userId: { type: sql.BigInt,          value: userId      },
    }
  );

  // ── 5. Record wallet debit transaction ──────────────────────────────────────
  const balanceAfter = parseFloat((walletBalance - totalAmount).toFixed(2));

  await query(
    `INSERT INTO dbo.wallet_transactions
       (user_id, type, amount, balance_after,
        description, reference_id, reference_type, created_at)
     VALUES
       (@userId, 'debit', @amount, @balanceAfter,
        @description, @referenceId, 'payment_order', SYSUTCDATETIME())`,
    {
      userId:       { type: sql.BigInt,         value: userId                                    },
      amount:       { type: sql.Decimal(10, 2), value: totalAmount                               },
      balanceAfter: { type: sql.Decimal(10, 2), value: balanceAfter                              },
      description:  { type: sql.NVarChar(300),  value: `Plan purchase: ${plan.name} (incl. GST)` },
      referenceId:  { type: sql.NVarChar(100),  value: String(orderId)                           },
    }
  );

  // ── 6. Create subscription ──────────────────────────────────────────────────
  const startDate = new Date();
  const expiresAt = new Date(Date.now() + plan.validity_days * 86_400_000);

  const toDateStr = (d) => d.toISOString().slice(0, 10);

  const subResult = await query(
    `INSERT INTO dbo.user_subscriptions
       (user_id, plan_id, order_id, status,
        start_date, expires_at,
        data_used_gb, created_at, updated_at)
     OUTPUT INSERTED.id
     VALUES
       (@userId, @planId, @orderId, 'active',
        @startDate, @expiresAt,
        0, SYSUTCDATETIME(), SYSUTCDATETIME())`,
    {
      userId:    { type: sql.BigInt, value: userId               },
      planId:    { type: sql.Int,    value: planId               },
      orderId:   { type: sql.BigInt, value: orderId              },
      startDate: { type: sql.Date,   value: toDateStr(startDate) },
      expiresAt: { type: sql.Date,   value: toDateStr(expiresAt) },
    }
  );

  const subscriptionId = subResult.recordset[0].id;

  // ── 7. Mark payment order as success ───────────────────────────────────────
  await query(
    `UPDATE dbo.payment_orders
     SET payment_status = 'success',
         paid_at        = SYSUTCDATETIME(),
         updated_at     = SYSUTCDATETIME()
     WHERE id = @orderId`,
    { orderId: { type: sql.BigInt, value: orderId } }
  );

  // ── 8. Activation notification ──────────────────────────────────────────────
  await query(
    `INSERT INTO dbo.notifications (user_id, type, title, body)
     VALUES (@userId, 'plan_activated', 'Plan Activated 🎉', @body)`,
    {
      userId: { type: sql.BigInt,        value: userId },
      body:   { type: sql.NVarChar(500), value: `Your ${plan.name} plan is active until ${expiresAt.toDateString()}. Enjoy ${plan.speed_mbps} Mbps!` },
    }
  );

  return {
    subscription_id: subscriptionId,
    order_id:        orderId,
    order_ref:       orderRef,
    plan,
    start_date:      startDate,
    expires_at:      expiresAt,
    amount_paid:     totalAmount,
    status:          'active',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the user's current active subscription, if any.
 */
async function getActiveSubscription(userId) {
  const result = await query(
    `SELECT TOP 1
       s.id              AS subscription_id,
       s.status,
       s.start_date,
       s.expires_at,
       s.data_used_gb,
       po.order_ref,
       po.total_amount   AS amount_paid,
       po.payment_method,
       p.id              AS plan_id,
       p.name            AS plan_name,
       p.speed_mbps,
       p.data_limit,
       p.validity_days,
       p.price,
       p.category
     FROM dbo.user_subscriptions s
     JOIN dbo.broadband_plans    p  ON p.id  = s.plan_id
     JOIN dbo.payment_orders     po ON po.id = s.order_id
     WHERE s.user_id = @userId
       AND s.status  = 'active'
       AND s.expires_at >= CAST(SYSDATETIME() AS DATE)
     ORDER BY s.expires_at DESC`,
    { userId: { type: sql.BigInt, value: userId } }
  );
  return result.recordset[0] || null;
}

/**
 * Paginated subscription history.
 */
async function getSubscriptionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT
         s.id           AS subscription_id,
         s.status,
         s.start_date,
         s.expires_at,
         s.data_used_gb,
         s.created_at,
         po.order_ref,
         po.total_amount AS amount_paid,
         po.payment_method,
         p.name          AS plan_name,
         p.speed_mbps,
         p.data_limit,
         p.validity_days,
         p.category
       FROM dbo.user_subscriptions s
       JOIN dbo.broadband_plans    p  ON p.id  = s.plan_id
       JOIN dbo.payment_orders     po ON po.id = s.order_id
       WHERE s.user_id = @userId
       ORDER BY s.created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        userId: { type: sql.BigInt, value: userId },
        offset: { type: sql.Int,    value: offset },
        limit:  { type: sql.Int,    value: limit  },
      }
    ),
    query(
      `SELECT COUNT(*) AS total FROM dbo.user_subscriptions WHERE user_id = @userId`,
      { userId: { type: sql.BigInt, value: userId } }
    ),
  ]);

  return {
    subscriptions: dataResult.recordset,
    total:         countResult.recordset[0].total,
  };
}

/**
 * Paginated wallet transaction history.
 */
async function getTransactionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT
         wt.id, wt.type, wt.amount, wt.balance_after,
         wt.description, wt.reference_id, wt.reference_type,
         wt.created_at,
         po.order_ref, po.payment_status,
         p.name AS plan_name
       FROM dbo.wallet_transactions wt
       LEFT JOIN dbo.payment_orders po
              ON po.id = TRY_CAST(wt.reference_id AS BIGINT)
             AND wt.reference_type IN ('payment_order', 'wallet_recharge')
       LEFT JOIN dbo.broadband_plans p ON p.id = po.plan_id
       WHERE wt.user_id = @userId
       ORDER BY wt.created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        userId: { type: sql.BigInt, value: userId },
        offset: { type: sql.Int,    value: offset },
        limit:  { type: sql.Int,    value: limit  },
      }
    ),
    query(
      `SELECT COUNT(*) AS total FROM dbo.wallet_transactions WHERE user_id = @userId`,
      { userId: { type: sql.BigInt, value: userId } }
    ),
  ]);

  return { transactions: dataResult.recordset, total: countResult.recordset[0].total };
}

module.exports = {
  getAllPlans,
  getPlanById,
  getActiveSubscription,
  getSubscriptionHistory,
  purchasePlan,
  getTransactionHistory,
};