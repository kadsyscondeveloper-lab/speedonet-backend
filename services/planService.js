// services/planService.js
const { sql, query } = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');

// ── Plans catalogue ───────────────────────────────────────────────────────────

async function getAllPlans() {
  const result = await query(
    `SELECT id, name, speed_mbps, data_limit_gb, validity_days, price, description
     FROM dbo.plans
     WHERE is_active = 1
     ORDER BY price ASC`
  );
  return result.recordset;
}

async function getPlanById(planId) {
  const result = await query(
    `SELECT id, name, speed_mbps, data_limit_gb, validity_days, price, description
     FROM dbo.plans
     WHERE id = @planId AND is_active = 1`,
    { planId: { type: sql.Int, value: planId } }
  );
  return result.recordset[0] || null;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

/**
 * Get the user's current active subscription (if any).
 */
async function getActiveSubscription(userId) {
  const result = await query(
    `SELECT TOP 1
       s.id, s.order_ref, s.status, s.amount_paid,
       s.starts_at, s.expires_at, s.activated_at,
       p.id AS plan_id, p.name AS plan_name,
       p.speed_mbps, p.data_limit_gb, p.validity_days, p.price
     FROM dbo.user_subscriptions s
     JOIN dbo.plans p ON p.id = s.plan_id
     WHERE s.user_id = @userId
       AND s.status = 'active'
       AND s.expires_at > SYSUTCDATETIME()
     ORDER BY s.expires_at DESC`,
    { userId: { type: sql.BigInt, value: userId } }
  );
  return result.recordset[0] || null;
}

/**
 * Get subscription history for a user.
 */
async function getSubscriptionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;
  const result = await query(
    `SELECT
       s.id, s.order_ref, s.status, s.amount_paid,
       s.starts_at, s.expires_at, s.created_at,
       p.name AS plan_name, p.speed_mbps, p.validity_days
     FROM dbo.user_subscriptions s
     JOIN dbo.plans p ON p.id = s.plan_id
     WHERE s.user_id = @userId
     ORDER BY s.created_at DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    {
      userId: { type: sql.BigInt, value: userId },
      offset: { type: sql.Int,    value: offset },
      limit:  { type: sql.Int,    value: limit  },
    }
  );

  const countResult = await query(
    `SELECT COUNT(*) AS total FROM dbo.user_subscriptions WHERE user_id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  return {
    subscriptions: result.recordset,
    total: countResult.recordset[0].total,
  };
}

/**
 * Create a pending subscription + debit transaction in one go.
 * Uses wallet balance by default. Payment gateway flow would go here later.
 *
 * Steps:
 *  1. Verify plan exists
 *  2. Check user wallet has enough balance
 *  3. Deduct wallet balance
 *  4. Insert subscription (pending)
 *  5. Insert transaction record (success)
 *  6. Activate subscription immediately (for wallet pay — no gateway delay)
 */
async function purchasePlan(userId, planId, paymentMode = 'wallet') {
  // 1. Get plan
  const plan = await getPlanById(planId);
  if (!plan) throw Object.assign(new Error('Plan not found or inactive.'), { statusCode: 404 });

  // 2. Get user wallet
  const userResult = await query(
    `SELECT wallet_balance FROM dbo.users WHERE id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );
  const user = userResult.recordset[0];
  if (!user) throw Object.assign(new Error('User not found.'), { statusCode: 404 });

  if (paymentMode === 'wallet') {
    if (parseFloat(user.wallet_balance) < parseFloat(plan.price)) {
      throw Object.assign(
        new Error(`Insufficient wallet balance. Required ₹${plan.price}, available ₹${user.wallet_balance}.`),
        { statusCode: 400 }
      );
    }
  }

  const orderRef  = generateOrderRef();
  const startsAt  = new Date();
  const expiresAt = new Date(Date.now() + plan.validity_days * 86400 * 1000);

  // 3. Deduct wallet (if wallet pay)
  if (paymentMode === 'wallet') {
    await query(
      `UPDATE dbo.users
       SET wallet_balance = wallet_balance - @amount,
           updated_at     = SYSUTCDATETIME()
       WHERE id = @userId`,
      {
        amount: { type: sql.Decimal(10, 2), value: plan.price },
        userId: { type: sql.BigInt,          value: userId     },
      }
    );
  }

  // 4. Insert subscription
  const subResult = await query(
    `INSERT INTO dbo.user_subscriptions
       (user_id, plan_id, order_ref, status, payment_mode, amount_paid,
        starts_at, expires_at, activated_at)
     OUTPUT INSERTED.id
     VALUES (@userId, @planId, @orderRef, 'active', @payMode,
             @amount, @startsAt, @expiresAt, SYSUTCDATETIME())`,
    {
      userId:    { type: sql.BigInt,        value: userId        },
      planId:    { type: sql.Int,            value: planId        },
      orderRef:  { type: sql.NVarChar(50),   value: orderRef      },
      payMode:   { type: sql.NVarChar(30),   value: paymentMode   },
      amount:    { type: sql.Decimal(10, 2), value: plan.price    },
      startsAt:  { type: sql.DateTime2,      value: startsAt      },
      expiresAt: { type: sql.DateTime2,      value: expiresAt     },
    }
  );

  const subscriptionId = subResult.recordset[0].id;

  // 5. Insert transaction record
  await query(
    `INSERT INTO dbo.transactions
       (user_id, subscription_id, order_ref, type, amount, payment_mode, status, note)
     VALUES (@userId, @subId, @orderRef, 'debit', @amount, @payMode, 'success', @note)`,
    {
      userId:   { type: sql.BigInt,        value: userId           },
      subId:    { type: sql.BigInt,        value: subscriptionId   },
      orderRef: { type: sql.NVarChar(50),  value: orderRef         },
      amount:   { type: sql.Decimal(10,2), value: plan.price       },
      payMode:  { type: sql.NVarChar(30),  value: paymentMode      },
      note:     { type: sql.NVarChar(300), value: `Plan: ${plan.name} (${plan.validity_days} days)` },
    }
  );

  // 6. Insert activation notification
  await query(
    `INSERT INTO dbo.notifications (user_id, type, title, body)
     VALUES (@userId, 'plan_activated', 'Plan Activated 🎉',
             @body)`,
    {
      userId: { type: sql.BigInt,        value: userId },
      body:   { type: sql.NVarChar(500), value: `Your ${plan.name} plan is now active until ${expiresAt.toDateString()}. Enjoy ${plan.speed_mbps} Mbps!` },
    }
  );

  return {
    subscription_id: subscriptionId,
    order_ref:       orderRef,
    plan:            plan,
    starts_at:       startsAt,
    expires_at:      expiresAt,
    amount_paid:     plan.price,
    status:          'active',
  };
}

// ── Transactions ──────────────────────────────────────────────────────────────

async function getTransactionHistory(userId, { page = 1, limit = 10 } = {}) {
  const offset = (page - 1) * limit;
  const result = await query(
    `SELECT
       t.id, t.order_ref, t.type, t.amount, t.payment_mode,
       t.status, t.gateway_ref, t.note, t.created_at,
       p.name AS plan_name
     FROM dbo.transactions t
     LEFT JOIN dbo.user_subscriptions s ON s.id = t.subscription_id
     LEFT JOIN dbo.plans p              ON p.id = s.plan_id
     WHERE t.user_id = @userId
     ORDER BY t.created_at DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    {
      userId: { type: sql.BigInt, value: userId },
      offset: { type: sql.Int,    value: offset },
      limit:  { type: sql.Int,    value: limit  },
    }
  );

  const countResult = await query(
    `SELECT COUNT(*) AS total FROM dbo.transactions WHERE user_id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  return {
    transactions: result.recordset,
    total: countResult.recordset[0].total,
  };
}

module.exports = {
  getAllPlans,
  getPlanById,
  getActiveSubscription,
  getSubscriptionHistory,
  purchasePlan,
  getTransactionHistory,
};