const { sql, query } = require('../config/db');

// ── Profile ───────────────────────────────────────────────────────────────────

async function getFullProfile(userId) {
  const result = await query(
    `SELECT
       u.id, u.name, u.phone, u.email, u.profile_image,
       u.wallet_balance, u.is_active, u.created_at,
       a.house_no, a.address, a.city, a.state, a.pin_code,
       k.status        AS kyc_status,
       k.submitted_at  AS kyc_submitted_at,
       rc.code         AS referral_code,
       rc.referral_url AS referral_url
     FROM dbo.users u
     LEFT JOIN dbo.user_addresses  a  ON a.user_id = u.id AND a.is_primary = 1
     LEFT JOIN dbo.kyc_submissions k  ON k.user_id = u.id
     LEFT JOIN dbo.referral_codes  rc ON rc.user_id = u.id
     WHERE u.id = @id`,
    { id: { type: sql.BigInt, value: userId } }
  );
  return result.recordset[0] || null;
}

async function updateBasicInfo(userId, { name, email }) {
  await query(
    `UPDATE dbo.users
     SET
       name       = COALESCE(@name,  name),
       email      = COALESCE(@email, email),
       updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      name:  { type: sql.NVarChar(100), value: name  || null },
      email: { type: sql.NVarChar(150), value: email || null },
      id:    { type: sql.BigInt,        value: userId },
    }
  );
}

async function updateProfileImage(userId, imageUrl) {
  await query(
    `UPDATE dbo.users
     SET profile_image = @url, updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      url: { type: sql.NVarChar(500), value: imageUrl },
      id:  { type: sql.BigInt,        value: userId   },
    }
  );
}

// ── Address ───────────────────────────────────────────────────────────────────

async function getAllAddresses(userId) {
  const result = await query(
    `SELECT id, label, house_no, address, city, state, pin_code, is_primary, created_at
     FROM dbo.user_addresses
     WHERE user_id = @userId
     ORDER BY is_primary DESC, created_at ASC`,
    { userId: { type: sql.BigInt, value: userId } }
  );
  return result.recordset;
}

async function upsertPrimaryAddress(userId, { house_no, address, city, state, pin_code }) {
  await query(
    `MERGE dbo.user_addresses AS target
     USING (SELECT @userId AS user_id) AS src
       ON target.user_id = src.user_id AND target.is_primary = 1
     WHEN MATCHED THEN
       UPDATE SET
         house_no   = COALESCE(@house_no, house_no),
         address    = COALESCE(@address,  address),
         city       = COALESCE(@city,     city),
         state      = COALESCE(@state,    state),
         pin_code   = COALESCE(@pin_code, pin_code),
         updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (user_id, label, house_no, address, city, state, pin_code, is_primary)
       VALUES (@userId, 'Primary', @house_no, @address, @city, @state, @pin_code, 1);`,
    {
      userId:   { type: sql.BigInt,        value: userId           },
      house_no: { type: sql.NVarChar(100), value: house_no || null },
      address:  { type: sql.NVarChar(300), value: address  || null },
      city:     { type: sql.NVarChar(100), value: city     || null },
      state:    { type: sql.NVarChar(100), value: state    || null },
      pin_code: { type: sql.NVarChar(10),  value: pin_code || null },
    }
  );
}

async function addAddress(userId, { label, house_no, address, city, state, pin_code }) {
  const result = await query(
    `INSERT INTO dbo.user_addresses (user_id, label, house_no, address, city, state, pin_code)
     OUTPUT INSERTED.id
     VALUES (@userId, @label, @house_no, @address, @city, @state, @pin_code)`,
    {
      userId:   { type: sql.BigInt,        value: userId           },
      label:    { type: sql.NVarChar(50),  value: label || 'Home'  },
      house_no: { type: sql.NVarChar(100), value: house_no || null },
      address:  { type: sql.NVarChar(300), value: address  || null },
      city:     { type: sql.NVarChar(100), value: city     || null },
      state:    { type: sql.NVarChar(100), value: state    || null },
      pin_code: { type: sql.NVarChar(10),  value: pin_code || null },
    }
  );
  return result.recordset[0];
}

async function deleteAddress(userId, addressId) {
  const result = await query(
    `DELETE FROM dbo.user_addresses
     OUTPUT DELETED.id
     WHERE id = @id AND user_id = @userId AND is_primary = 0`,
    {
      id:     { type: sql.BigInt, value: addressId },
      userId: { type: sql.BigInt, value: userId    },
    }
  );
  return result.recordset.length > 0;
}

// ── KYC ───────────────────────────────────────────────────────────────────────

async function getKycStatus(userId) {
  const result = await query(
    `SELECT TOP 1
       id, status, rejection_reason,
       address_proof_type, id_proof_type,
       submitted_at, reviewed_at
     FROM dbo.kyc_submissions
     WHERE user_id = @userId
     ORDER BY submitted_at DESC`,
    { userId: { type: sql.BigInt, value: userId } }
  );
  return result.recordset[0] || null;
}

async function submitKyc(userId, {
  address_proof_type,
  address_proof_data,
  address_proof_mime,
  id_proof_type,
  id_proof_data,
  id_proof_mime,
}) {
  // Check for existing submission
  const existing = await query(
    `SELECT TOP 1 id, status FROM dbo.kyc_submissions
     WHERE user_id = @userId ORDER BY submitted_at DESC`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  const row = existing.recordset[0];

  if (row && ['pending', 'under_review'].includes(row.status)) {
    // Update existing pending submission
    await query(
      `UPDATE dbo.kyc_submissions SET
         address_proof_type = @apt,
         address_proof_data = @apd,
         address_proof_mime = @apm,
         id_proof_type      = @ipt,
         id_proof_data      = @ipd,
         id_proof_mime      = @ipm,
         status             = 'pending',
         submitted_at       = SYSUTCDATETIME(),
         updated_at         = SYSUTCDATETIME()
       WHERE id = @id`,
      {
        apt: { type: sql.NVarChar(100), value: address_proof_type },
        apd: { type: sql.NVarChar(sql.MAX), value: address_proof_data },
        apm: { type: sql.NVarChar(50),  value: address_proof_mime },
        ipt: { type: sql.NVarChar(100), value: id_proof_type      },
        ipd: { type: sql.NVarChar(sql.MAX), value: id_proof_data  },
        ipm: { type: sql.NVarChar(50),  value: id_proof_mime      },
        id:  { type: sql.BigInt,        value: row.id             },
      }
    );
    return row.id;
  }

  // Fresh submission
  const result = await query(
    `INSERT INTO dbo.kyc_submissions
       (user_id, address_proof_type, address_proof_data, address_proof_mime,
        id_proof_type, id_proof_data, id_proof_mime, status)
     OUTPUT INSERTED.id
     VALUES (@userId, @apt, @apd, @apm, @ipt, @ipd, @ipm, 'pending')`,
    {
      userId: { type: sql.BigInt,        value: userId             },
      apt:    { type: sql.NVarChar(100), value: address_proof_type },
      apd:    { type: sql.NVarChar(sql.MAX), value: address_proof_data },
      apm:    { type: sql.NVarChar(50),  value: address_proof_mime },
      ipt:    { type: sql.NVarChar(100), value: id_proof_type      },
      ipd:    { type: sql.NVarChar(sql.MAX), value: id_proof_data  },
      ipm:    { type: sql.NVarChar(50),  value: id_proof_mime      },
    }
  );
  return result.recordset[0].id;
}

// ── Notifications ─────────────────────────────────────────────────────────────

async function getNotifications(userId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const result = await query(
    `SELECT id, type, title, body, is_read, deep_link, created_at
     FROM dbo.notifications
     WHERE user_id = @userId
     ORDER BY created_at DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    {
      userId: { type: sql.BigInt, value: userId },
      offset: { type: sql.Int,    value: offset },
      limit:  { type: sql.Int,    value: limit  },
    }
  );

  const countResult = await query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM dbo.notifications WHERE user_id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  return {
    notifications: result.recordset,
    total:  countResult.recordset[0].total,
    unread: countResult.recordset[0].unread,
  };
}

async function markNotificationsRead(userId, ids = null) {
  if (ids && ids.length) {
    const placeholders = ids.map((_, i) => `@id${i}`).join(',');
    const params = { userId: { type: sql.BigInt, value: userId } };
    ids.forEach((id, i) => {
      params[`id${i}`] = { type: sql.BigInt, value: id };
    });
    await query(
      `UPDATE dbo.notifications
       SET is_read = 1
       WHERE user_id = @userId AND id IN (${placeholders})`,
      params
    );
  } else {
    await query(
      `UPDATE dbo.notifications SET is_read = 1 WHERE user_id = @userId`,
      { userId: { type: sql.BigInt, value: userId } }
    );
  }
}

// ── Referrals ─────────────────────────────────────────────────────────────────

async function getReferralStats(userId) {
  const codeResult = await query(
    `SELECT code, referral_url FROM dbo.referral_codes WHERE user_id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  const statsResult = await query(
    `SELECT
       COUNT(*)                                               AS total_referrals,
       SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END)  AS rewarded,
       SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END)  AS pending,
       ISNULL(SUM(referrer_reward), 0)                        AS total_earned
     FROM dbo.referrals WHERE referrer_id = @userId`,
    { userId: { type: sql.BigInt, value: userId } }
  );

  return {
    referral_code: codeResult.recordset[0] || null,
    stats:         statsResult.recordset[0],
  };
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
};