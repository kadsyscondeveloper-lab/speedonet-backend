/**
 * services/userService.js
 * Kysely rewrite — identical exports to the original so controllers need no changes.
 *
 * Change vs original: upsertPrimaryAddress uses select → update-or-insert
 * instead of T-SQL MERGE (Kysely has no MERGE helper for SQL Server).
 */

const { db, sql } = require('../config/db');

// ── Profile ───────────────────────────────────────────────────────────────────

async function getFullProfile(userId) {
  const row = await db
    .selectFrom('dbo.users as u')
    .leftJoin(
      'dbo.user_addresses as a',
      (join) => join
        .onRef('a.user_id', '=', 'u.id')
        .on('a.is_primary', '=', true),
    )
    .leftJoin('dbo.referral_codes as rc', 'rc.user_id', 'u.id')
    .select([
      'u.id', 'u.name', 'u.phone', 'u.email', 'u.profile_image',
      'u.wallet_balance', 'u.is_active', 'u.created_at',
      'u.availability_confirmed',
      'a.house_no', 'a.address', 'a.city', 'a.state', 'a.pin_code',
      'rc.code as referral_code',
      'rc.referral_url as referral_url',
      // ── Correlated subqueries for latest KYC submission ──
      sql`(
        SELECT TOP 1 status 
        FROM dbo.kyc_submissions 
        WHERE user_id = u.id 
        ORDER BY submitted_at DESC
      )`.as('kyc_status'),
      sql`(
        SELECT TOP 1 submitted_at 
        FROM dbo.kyc_submissions 
        WHERE user_id = u.id 
        ORDER BY submitted_at DESC
      )`.as('kyc_submitted_at'),
    ])
    .where('u.id', '=', BigInt(userId))
    .executeTakeFirst();
  return row ?? null;
}

async function updateBasicInfo(userId, { name, email }) {
  const updates = { updated_at: sql`SYSUTCDATETIME()` };
  if (name  != null) updates.name  = name;
  if (email != null) updates.email = email;

  await db
    .updateTable('dbo.users')
    .set(updates)
    .where('id', '=', BigInt(userId))
    .execute();
}

async function updateProfileImage(userId, imageUrl) {
  await db
    .updateTable('dbo.users')
    .set({ profile_image: imageUrl, updated_at: sql`SYSUTCDATETIME()` })
    .where('id', '=', BigInt(userId))
    .execute();
}

// ── Address ───────────────────────────────────────────────────────────────────

async function getAllAddresses(userId) {
  return db
    .selectFrom('dbo.user_addresses')
    .select([
      'id', 'label', 'house_no', 'address',
      'city', 'state', 'pin_code', 'is_primary', 'created_at',
    ])
    .where('user_id', '=', BigInt(userId))
    .orderBy('is_primary', 'desc')
    .orderBy('created_at', 'asc')
    .execute();
}

async function upsertPrimaryAddress(userId, { house_no, address, city, state, pin_code }) {
  // Kysely has no MERGE for SQL Server — do a manual upsert instead
  const existing = await db
    .selectFrom('dbo.user_addresses')
    .select('id')
    .where('user_id',    '=', BigInt(userId))
    .where('is_primary', '=', true)
    .executeTakeFirst();

  if (existing) {
    const updates = { updated_at: sql`SYSUTCDATETIME()` };
    if (house_no != null) updates.house_no = house_no;
    if (address  != null) updates.address  = address;
    if (city     != null) updates.city     = city;
    if (state    != null) updates.state    = state;
    if (pin_code != null) updates.pin_code = pin_code;

    await db
      .updateTable('dbo.user_addresses')
      .set(updates)
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('dbo.user_addresses')
      .values({
        user_id:    BigInt(userId),
        label:      'Primary',
        is_primary: true,
        house_no:   house_no ?? null,
        address:    address  ?? null,
        city:       city     ?? null,
        state:      state    ?? null,
        pin_code:   pin_code ?? null,
      })
      .execute();
  }
}

async function addAddress(userId, { label, house_no, address, city, state, pin_code }) {
  return db
    .insertInto('dbo.user_addresses')
    .values({
      user_id:  BigInt(userId),
      label:    label    ?? 'Home',
      house_no: house_no ?? null,
      address:  address  ?? null,
      city:     city     ?? null,
      state:    state    ?? null,
      pin_code: pin_code ?? null,
    })
    .output(['inserted.id'])
    .executeTakeFirstOrThrow();
}

async function deleteAddress(userId, addressId) {
  const row = await db
    .deleteFrom('dbo.user_addresses')
    .where('id',         '=', BigInt(addressId))
    .where('user_id',    '=', BigInt(userId))
    .where('is_primary', '=', false)
    .output(['inserted.id'])
    .executeTakeFirst();
  return !!row;
}

// ── KYC ───────────────────────────────────────────────────────────────────────

async function getKycStatus(userId) {
  const row = await db
    .selectFrom('dbo.kyc_submissions')
    .select([
      'id', 'status', 'rejection_reason',
      'address_proof_type', 'id_proof_type',
      'submitted_at', 'reviewed_at',
    ])
    .where('user_id', '=', BigInt(userId))
    .orderBy('submitted_at', 'desc')
    .top(1)
    .executeTakeFirst();
  return row ?? null;
}

async function submitKyc(userId, {
  address_proof_type, address_proof_data, address_proof_mime,
  id_proof_type,      id_proof_data,      id_proof_mime,
}) {
  const existing = await db
    .selectFrom('dbo.kyc_submissions')
    .select(['id', 'status'])
    .where('user_id', '=', BigInt(userId))
    .orderBy('submitted_at', 'desc')
    .top(1)
    .executeTakeFirst();

  if (existing && ['pending', 'under_review'].includes(existing.status)) {
    await db
      .updateTable('dbo.kyc_submissions')
      .set({
        address_proof_type,
        address_proof_data,
        address_proof_mime,
        id_proof_type,
        id_proof_data,
        id_proof_mime,
        status:       'pending',
        submitted_at: sql`SYSUTCDATETIME()`,
        updated_at:   sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', existing.id)
      .execute();
    return existing.id;
  }

  const row = await db
    .insertInto('dbo.kyc_submissions')
    .values({
      user_id: BigInt(userId),
      address_proof_type,
      address_proof_data,
      address_proof_mime,
      id_proof_type,
      id_proof_data,
      id_proof_mime,
    })
    .output(['inserted.id'])
    .executeTakeFirstOrThrow();

  return row.id;
}

// ── Notifications ─────────────────────────────────────────────────────────────

async function getNotifications(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    // Use raw SQL instead of query builder for pagination
    sql`
      SELECT id, type, title, body, is_read, deep_link, created_at
      FROM dbo.notifications
      WHERE user_id = ${BigInt(userId)}
      ORDER BY created_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
    `.execute(db).then(r => r.rows),

    db
      .selectFrom('dbo.notifications')
      .select([
        db.fn.count('id').as('total'),
        sql`SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END)`.as('unread'),
      ])
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);

  return {
    notifications: rows,
    total: Number(countRow.total),
    unread: Number(countRow.unread),
  };
}

async function markNotificationsRead(userId, ids = null) {
  let query = db
    .updateTable('dbo.notifications')
    .set({ is_read: true })
    .where('user_id', '=', BigInt(userId));

  if (ids && ids.length > 0) {
    query = query.where('id', 'in', ids.map(BigInt));
  }

  await query.execute();
}

// ── Referrals ─────────────────────────────────────────────────────────────────

async function getReferralStats(userId) {
  const [codeRow, statsRow] = await Promise.all([
    db
      .selectFrom('dbo.referral_codes')
      .select(['code', 'referral_url'])
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirst(),

    db
      .selectFrom('dbo.referrals')
      .select([
        db.fn.count('id').as('total_referrals'),
        sql`SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END)`.as('rewarded'),
        sql`SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END)`.as('pending'),
        sql`ISNULL(SUM(referrer_reward), 0)`.as('total_earned'),
      ])
      .where('referrer_id', '=', BigInt(userId))
      .executeTakeFirstOrThrow(),
  ]);

  return {
    referral_code: codeRow ?? null,
    stats:         statsRow,
  };
}


// ── Coupons ───────────────────────────────────────────────────────────────────

async function getMyCoupons(userId) {
  return db
    .selectFrom('dbo.coupons')
    .select([
      'code', 'description', 'discount_type',
      'discount_value', 'max_discount_amount',
      'valid_to', 'is_active',
    ])
    .where('user_id',   '=', BigInt(userId))
    .where('is_active', '=', true)
    .where('valid_to',  '>', new Date())
    .execute();
}

module.exports = {
  getFullProfile,
  updateBasicInfo,
  updateProfileImage,
  getAllAddresses,
  upsertPrimaryAddress,
  addAddress,
  deleteAddress,
  getKycStatus,
  submitKyc,
  getNotifications,
  markNotificationsRead,
  getReferralStats,
  getMyCoupons,
};