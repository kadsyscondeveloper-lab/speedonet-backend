// services/walletService.js
const { sql, query } = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');

// ── Balance ───────────────────────────────────────────────────────────────────

async function getWalletBalance(userId) {
  const result = await query(
    `SELECT wallet_balance FROM dbo.users WHERE id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );
  const user = result.recordset[0];
  if (!user) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  return parseFloat(user.wallet_balance);
}

// ── Transaction history ───────────────────────────────────────────────────────

async function getWalletTransactions(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT
         wt.id,
         wt.type,
         wt.amount,
         wt.balance_after,
         wt.description,
         wt.reference_id,
         wt.reference_type,
         wt.created_at,
         po.order_ref,
         po.payment_method,
         po.payment_status
       FROM dbo.wallet_transactions wt
       LEFT JOIN dbo.payment_orders po
              ON po.id = TRY_CAST(wt.reference_id AS BIGINT)
             AND wt.reference_type IN ('payment_order', 'wallet_recharge')
       WHERE wt.user_id = @userId
       ORDER BY wt.created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      {
        userId: { type: sql.BigInt, value: userId },
        offset: { type: sql.Int,    value: offset  },
        limit:  { type: sql.Int,    value: limit   },
      }
    ),
    query(
      `SELECT COUNT(*) AS total FROM dbo.wallet_transactions WHERE user_id = @userId`,
      { userId: { type: sql.BigInt, value: userId } }
    ),
  ]);

  return {
    transactions: dataResult.recordset,
    total:        countResult.recordset[0].total,
  };
}

// ── Recharge ──────────────────────────────────────────────────────────────────

/**
 * Credit the wallet.
 *
 * In production, call this ONLY from a verified payment gateway webhook.
 * For now it auto-confirms so you can test end-to-end.
 *
 * Flow:
 *   1. Validate amount
 *   2. INSERT payment_orders (type = 'wallet_recharge')
 *   3. UPDATE users.wallet_balance
 *   4. INSERT wallet_transactions (credit)
 *   5. UPDATE payment_orders → paid
 *   6. INSERT notification
 */
async function rechargeWallet(userId, { amount, paymentMethod = 'upi', gatewayOrderId = null, gatewayTxnId = null } = {}) {
  amount = parseFloat(parseFloat(amount).toFixed(2));

  if (isNaN(amount) || amount < 10) {
    throw Object.assign(new Error('Minimum recharge amount is ₹10.'), { statusCode: 400 });
  }
  if (amount > 50000) {
    throw Object.assign(new Error('Maximum recharge amount is ₹50,000.'), { statusCode: 400 });
  }

  // 1. Get current balance (for balance_after calculation)
  const currentBalance = await getWalletBalance(userId);

  const orderRef   = generateOrderRef();
  const balanceAfter = parseFloat((currentBalance + amount).toFixed(2));

  // 2. Insert payment order
  // Change 'paid' → 'success' in the INSERT
const orderResult = await query(
  `INSERT INTO dbo.payment_orders
     (user_id, order_ref, type, plan_id, provider_id,
      base_amount, gst_amount, discount_amount, total_amount,
      payment_method, payment_status,
      gateway_name, gateway_order_id, gateway_txn_id,
      paid_at, created_at, updated_at)
   OUTPUT INSERTED.id
   VALUES
     (@userId, @orderRef, 'wallet_recharge', NULL, NULL,
      @amount, 0, 0, @amount,
      @payMethod, 'success',            -- ← was 'paid'
      @payMethod, @gatewayOrderId, @gatewayTxnId,
      SYSUTCDATETIME(), SYSUTCDATETIME(), SYSUTCDATETIME())`,
  {
    userId:         { type: sql.BigInt,        value: userId        },
    orderRef:       { type: sql.NVarChar(64),   value: orderRef      },
    amount:         { type: sql.Decimal(10, 2), value: amount        },
    payMethod:      { type: sql.NVarChar(20),   value: paymentMethod },
    gatewayOrderId: { type: sql.NVarChar(200),  value: gatewayOrderId },
    gatewayTxnId:   { type: sql.NVarChar(200),  value: gatewayTxnId  },
  }
);

  const orderId = orderResult.recordset[0].id;

  // 3. Credit wallet balance
  await query(
    `UPDATE dbo.users
     SET wallet_balance = wallet_balance + @amount,
         updated_at     = SYSUTCDATETIME()
     WHERE id = @userId`,
    {
      amount: { type: sql.Decimal(10, 2), value: amount },
      userId: { type: sql.BigInt,          value: userId },
    }
  );

  // 4. Insert wallet transaction (credit)
  await query(
    `INSERT INTO dbo.wallet_transactions
       (user_id, type, amount, balance_after,
        description, reference_id, reference_type, created_at)
     VALUES
       (@userId, 'credit', @amount, @balanceAfter,
        @description, @referenceId, 'wallet_recharge', SYSUTCDATETIME())`,
    {
      userId:       { type: sql.BigInt,        value: userId                        },
      amount:       { type: sql.Decimal(10, 2), value: amount                       },
      balanceAfter: { type: sql.Decimal(10, 2), value: balanceAfter                 },
      description:  { type: sql.NVarChar(300),  value: `Wallet recharge via ${paymentMethod}` },
      referenceId:  { type: sql.NVarChar(100),  value: String(orderId)              },
    }
  );

  // 5. Notification
  await query(
    `INSERT INTO dbo.notifications (user_id, type, title, body)
     VALUES (@userId, 'wallet_recharge', 'Wallet Recharged 💰', @body)`,
    {
      userId: { type: sql.BigInt,        value: userId },
      body:   { type: sql.NVarChar(500), value: `₹${amount.toFixed(2)} added to your wallet. New balance: ₹${balanceAfter.toFixed(2)}.` },
    }
  );

  return {
    order_id:      orderId,
    order_ref:     orderRef,
    amount,
    balance_after: balanceAfter,
    payment_method: paymentMethod,
    status:        'success',
  };
}

module.exports = { getWalletBalance, getWalletTransactions, rechargeWallet };