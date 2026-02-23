// services/walletService.js
const { db, sql } = require('../config/db');
const { generateOrderRef } = require('../utils/helpers');

// ── Balance ───────────────────────────────────────────────────────────────────

async function getWalletBalance(userId) {
  const row = await db
    .selectFrom('dbo.users')
    .select('wallet_balance')
    .where('id', '=', BigInt(userId))
    .executeTakeFirst();

  if (!row) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  return parseFloat(row.wallet_balance);
}

// ── Transaction history ───────────────────────────────────────────────────────

async function getWalletTransactions(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    sql`
      SELECT
        wt.id, wt.type, wt.amount, wt.balance_after,
        wt.description, wt.reference_id, wt.reference_type, wt.created_at,
        po.order_ref, po.payment_method, po.payment_status
      FROM dbo.wallet_transactions wt
      LEFT JOIN dbo.payment_orders po
             ON po.id = TRY_CAST(wt.reference_id AS BIGINT)
            AND wt.reference_type IN ('payment_order', 'wallet_recharge')
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

// ── Recharge ──────────────────────────────────────────────────────────────────

/**
 * Credit the wallet after a successful Atom payment.
 *
 * @param {number} userId
 * @param {object} opts
 * @param {number}  opts.amount
 * @param {string}  opts.paymentMethod
 * @param {string}  [opts.gatewayOrderId]
 * @param {string}  [opts.gatewayTxnId]
 * @param {string}  [opts.existingOrderRef]  — when set, skip creating a new payment_order
 *                                             (the order was already created by paymentController)
 */
async function rechargeWallet(userId, {
  amount,
  paymentMethod  = 'upi',
  gatewayOrderId = null,
  gatewayTxnId   = null,
  existingOrderRef = null,   // ← NEW — prevents duplicate order creation
} = {}) {
  const amt = parseFloat(parseFloat(amount).toFixed(2));

  if (isNaN(amt) || amt < 10)  throw Object.assign(new Error('Minimum recharge amount is ₹10.'),     { statusCode: 400 });
  if (amt > 50_000)            throw Object.assign(new Error('Maximum recharge amount is ₹50,000.'), { statusCode: 400 });

  const currentBalance = await getWalletBalance(userId);
  const balanceAfter   = parseFloat((currentBalance + amt).toFixed(2));

  return db.transaction().execute(async (trx) => {

    let orderId;
    let orderRef;

    if (existingOrderRef) {
      // ── Atom payment flow: order already exists, just look it up ──────────
      const existingOrder = await trx
        .selectFrom('dbo.payment_orders')
        .select(['id', 'order_ref'])
        .where('order_ref', '=', existingOrderRef)
        .where('user_id',   '=', BigInt(userId))
        .executeTakeFirst();

      if (!existingOrder) {
        // Fallback: shouldn't happen, but don't block the credit
        orderRef = existingOrderRef;
        orderId  = null;
      } else {
        orderId  = existingOrder.id;
        orderRef = existingOrder.order_ref;
      }
    } else {
      // ── Direct recharge flow (manual / legacy): create a fresh order ──────
      orderRef = generateOrderRef();

      const orderRow = await trx
        .insertInto('dbo.payment_orders')
        .values({
          user_id:          BigInt(userId),
          order_ref:        orderRef,
          type:             'wallet_recharge',
          plan_id:          null,
          provider_id:      null,
          base_amount:      String(amt),
          gst_amount:       '0',
          discount_amount:  '0',
          total_amount:     String(amt),
          payment_method:   paymentMethod,
          payment_status:   'success',
          gateway_name:     paymentMethod,
          gateway_order_id: gatewayOrderId,
          gateway_txn_id:   gatewayTxnId,
          paid_at:          new Date(),
        })
        .output(['inserted.id'])
        .executeTakeFirstOrThrow();

      orderId = orderRow.id;
    }

    // ── Credit wallet ────────────────────────────────────────────────────────
    await trx
      .updateTable('dbo.users')
      .set({
        wallet_balance: sql`wallet_balance + ${amt}`,
        updated_at:     sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', BigInt(userId))
      .execute();

    // ── Record wallet credit transaction ─────────────────────────────────────
    await trx
      .insertInto('dbo.wallet_transactions')
      .values({
        user_id:        BigInt(userId),
        type:           'credit',
        amount:         String(amt),
        balance_after:  String(balanceAfter),
        description:    `Wallet recharge via ${paymentMethod}`,
        reference_id:   orderId ? String(orderId) : orderRef,
        reference_type: 'wallet_recharge',
      })
      .execute();

    // ── Notification ─────────────────────────────────────────────────────────
    await trx
      .insertInto('dbo.notifications')
      .values({
        user_id: BigInt(userId),
        type:    'wallet_recharge',
        title:   'Wallet Recharged 💰',
        body:    `₹${amt.toFixed(2)} added to your wallet. New balance: ₹${balanceAfter.toFixed(2)}.`,
      })
      .execute();

    return {
      order_id:       orderId,
      order_ref:      orderRef,
      amount:         amt,
      balance_after:  balanceAfter,
      payment_method: paymentMethod,
      status:         'success',
    };
  });
}

module.exports = { getWalletBalance, getWalletTransactions, rechargeWallet };