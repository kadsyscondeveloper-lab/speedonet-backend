// services/billService.js
const { db, sql } = require('../config/db');

/**
 * GET /api/v1/user/bills
 * Returns paginated bill list for the authenticated user.
 * Joins with broadband_plans to get the plan name.
 */
async function getUserBills(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    sql`
      SELECT
        b.id,
        b.bill_number,
        b.billing_period_start,
        b.billing_period_end,
        b.base_amount,
        b.gst_amount,
        b.total_amount,
        b.due_date,
        b.status,
        b.paid_at,
        b.created_at,
        p.name AS plan_name
      FROM dbo.bills b
      LEFT JOIN dbo.broadband_plans p ON p.id = b.plan_id
      WHERE b.user_id = ${BigInt(userId)}
      ORDER BY b.created_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows),

    db
      .selectFrom('dbo.bills')
      .select(db.fn.count('id').as('total'))
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);

  return { bills: rows, total: Number(countRow.total) };
}

/**
 * GET /api/v1/user/bills/:id
 * Returns a single bill detail.
 */
async function getBillById(userId, billId) {
  const row = await sql`
    SELECT
      b.id,
      b.bill_number,
      b.billing_period_start,
      b.billing_period_end,
      b.base_amount,
      b.gst_amount,
      b.total_amount,
      b.due_date,
      b.status,
      b.paid_via_order,
      b.paid_at,
      b.created_at,
      p.name AS plan_name,
      po.order_ref,
      po.payment_method
    FROM dbo.bills b
    LEFT JOIN dbo.broadband_plans p ON p.id = b.plan_id
    LEFT JOIN dbo.payment_orders po ON po.id = b.paid_via_order
    WHERE b.id = ${BigInt(billId)}
      AND b.user_id = ${BigInt(userId)}
  `.execute(db).then(r => r.rows[0] ?? null);

  return row;
}

module.exports = { getUserBills, getBillById };