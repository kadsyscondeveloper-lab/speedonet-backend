// services/rentService.js
//
// Daily rent for users with active broadband plans.
//
// Rules:
//   • Each day the user can collect a fixed `daily_rent` amount once.
//   • The amount is fixed — it does NOT accumulate across days.
//   • Miss today's window → that day's rent is gone forever.
//   • Collection is only allowed inside the user's assigned 30-min IST slot.
//   • Slot is derived deterministically from userId % 18 (10 AM – 7 PM IST).

const { db, sql } = require('../config/db');
const notifyUser  = require('../utils/notifyUser');
const logger      = require('../utils/logger');

// ── Collection window config ──────────────────────────────────────────────────

const SLOT_DURATION_MINS = 30;
const WINDOW_START_HOUR  = 10;   // 10:00 AM IST
const WINDOW_END_HOUR    = 19;   // 07:00 PM IST
const TOTAL_SLOTS        = ((WINDOW_END_HOUR - WINDOW_START_HOUR) * 60) / SLOT_DURATION_MINS; // 18

// ── IST helpers ───────────────────────────────────────────────────────────────

function _istNow() {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
}

function _istDateStr(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Slot helpers ──────────────────────────────────────────────────────────────

/**
 * Deterministic slot index (0–17) from userId.
 * Same user always gets the same slot on every call.
 */
function _slotForUser(userId) {
  return Number(userId) % TOTAL_SLOTS;
}

/**
 * IST start/end bounds for a slot index.
 */
function _slotBounds(slotIndex) {
  const startMins = WINDOW_START_HOUR * 60 + slotIndex * SLOT_DURATION_MINS;
  const endMins   = startMins + SLOT_DURATION_MINS;
  return {
    startH: Math.floor(startMins / 60),
    startM: startMins % 60,
    endH:   Math.floor(endMins / 60),
    endM:   endMins % 60,
  };
}

/**
 * Human-readable label — e.g. "2:30 PM – 3:00 PM IST"
 */
function _windowLabel(slotIndex) {
  const { startH, startM, endH, endM } = _slotBounds(slotIndex);
  const fmt = (h, m) => {
    const period = h < 12 ? 'AM' : 'PM';
    const h12    = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };
  return `${fmt(startH, startM)} – ${fmt(endH, endM)} IST`;
}

/**
 * True if current IST time is inside the user's slot.
 */
function _isInCollectionWindow(slotIndex) {
  const ist     = _istNow();
  const nowMins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const { startH, startM, endH, endM } = _slotBounds(slotIndex);
  return nowMins >= (startH * 60 + startM) && nowMins < (endH * 60 + endM);
}

// ── Main: get rent status for a user ─────────────────────────────────────────

async function getRentStatus(userId) {
  const slotIndex = _slotForUser(userId);

  // 1. Need an active subscription
  const sub = await db
    .selectFrom('dbo.user_subscriptions as s')
    .innerJoin('dbo.broadband_plans as p', 'p.id', 's.plan_id')
    .select([
      's.id as sub_id',
      'p.name as plan_name',
      'p.price',
      'p.validity_days',
      'p.daily_rent',
    ])
    .where('s.user_id',    '=', BigInt(userId))
    .where('s.status',     '=', 'active')
    .where('s.start_date', '<=', sql`CAST(SYSDATETIME() AS DATE)`)
    .where('s.expires_at', '>=', sql`CAST(SYSDATETIME() AS DATE)`)
    .orderBy('s.expires_at', 'desc')
    .top(1)
    .executeTakeFirst();

  if (!sub) {
    return {
      hasActivePlan:      false,
      dailyRent:          0,
      totalCollected:     0,
      canCollect:         false,
      collectedToday:     false,
      inCollectionWindow: _isInCollectionWindow(slotIndex),
      slotIndex,
      windowLabel:        _windowLabel(slotIndex),
      message:            'Purchase a plan to start earning daily rent.',
    };
  }

  // 2. Fixed daily rent — no accumulation, this is exactly what they can collect today
  const dailyRent = sub.daily_rent !== null && sub.daily_rent !== undefined
    ? parseFloat(sub.daily_rent)
    : parseFloat((parseFloat(sub.price) / sub.validity_days).toFixed(2));

  // 3. Fetch wallet row (only needed for totalCollected + collectedToday check)
  const wallet = await db
    .selectFrom('dbo.rent_wallets')
    .select(['total_collected', 'last_collected_at'])
    .where('user_id', '=', BigInt(userId))
    .executeTakeFirst();

  // 4. Check if already collected today (IST date comparison)
  const todayStr = _istDateStr(_istNow());
  const lastCollectedIST = wallet?.last_collected_at
    ? _istDateStr(new Date(new Date(wallet.last_collected_at).getTime() + 5.5 * 60 * 60 * 1000))
    : null;
  const collectedToday = lastCollectedIST === todayStr;

  // 5. Window + eligibility
  const inWindow   = _isInCollectionWindow(slotIndex);
  const canCollect = inWindow && !collectedToday;

  let message = null;
  if (!inWindow) {
    message = `Your collection window: ${_windowLabel(slotIndex)}. Miss it and today's rent is gone.`;
  } else if (collectedToday) {
    message = 'Already collected today. Come back tomorrow!';
  }

  return {
    hasActivePlan:      true,
    planName:           sub.plan_name,
    dailyRent,                                              // fixed amount, same every day
    totalCollected:     parseFloat(wallet?.total_collected || 0),
    canCollect,
    collectedToday,
    inCollectionWindow: inWindow,
    slotIndex,
    windowLabel:        _windowLabel(slotIndex),
    message,
  };
}

// ── Main: collect today's rent ────────────────────────────────────────────────

async function collectRent(userId) {
  const status = await getRentStatus(userId);

  if (!status.hasActivePlan) {
    throw Object.assign(
      new Error('No active plan found. Purchase a plan to earn rent.'),
      { statusCode: 400 }
    );
  }

  if (!status.inCollectionWindow) {
    throw Object.assign(
      new Error(`Rent can only be collected during ${status.windowLabel}.`),
      { statusCode: 400 }
    );
  }

  if (status.collectedToday) {
    throw Object.assign(
      new Error('You have already collected rent today. Come back tomorrow!'),
      { statusCode: 400 }
    );
  }

  const amount    = status.dailyRent; // fixed — no accumulation
  const slotIndex = _slotForUser(userId);
  const now       = new Date();

  return db.transaction().execute(async (trx) => {
    // Fetch wallet for race guard + upsert
    const wallet = await trx
      .selectFrom('dbo.rent_wallets')
      .select(['id', 'last_collected_at'])
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirst();

    // Race condition guard — double check inside transaction
    if (wallet?.last_collected_at) {
      const alreadyIST = _istDateStr(
        new Date(new Date(wallet.last_collected_at).getTime() + 5.5 * 60 * 60 * 1000)
      );
      if (alreadyIST === _istDateStr(_istNow())) {
        throw Object.assign(
          new Error('You have already collected rent today.'),
          { statusCode: 400 }
        );
      }
    }

    // Read balance with row lock
    const userRow = await sql`
      SELECT wallet_balance FROM dbo.users WITH (UPDLOCK, ROWLOCK)
      WHERE id = ${BigInt(userId)}
    `.execute(trx).then(r => r.rows[0]);

    const balanceAfter = parseFloat(
      (parseFloat(userRow.wallet_balance) + amount).toFixed(2)
    );

    // 1. Credit user wallet
    await trx
      .updateTable('dbo.users')
      .set({
        wallet_balance: sql`wallet_balance + ${amount}`,
        updated_at:     sql`SYSUTCDATETIME()`,
      })
      .where('id', '=', BigInt(userId))
      .execute();

    // 2. Upsert rent wallet
    if (wallet) {
      await trx
        .updateTable('dbo.rent_wallets')
        .set({
          last_collected_at: now,
          total_collected:   sql`total_collected + ${amount}`,
          updated_at:        sql`SYSUTCDATETIME()`,
        })
        .where('id', '=', wallet.id)
        .execute();
    } else {
      // First ever collect — create wallet row
      await trx
        .insertInto('dbo.rent_wallets')
        .values({
          user_id:           BigInt(userId),
          pending_rent:      '0',   // unused but column exists — kept at 0
          total_collected:   String(amount),
          last_collected_at: now,
          rent_slot:         slotIndex,
        })
        .execute();
    }

    // 3. Wallet transaction record
    await trx
      .insertInto('dbo.wallet_transactions')
      .values({
        user_id:        BigInt(userId),
        type:           'credit',
        amount:         String(amount),
        balance_after:  String(balanceAfter),
        description:    `Daily rent collection — ${status.planName}`,
        reference_type: 'rent',
        reference_id:   String(userId),
      })
      .execute();

    // 4. Push notification
    await notifyUser(trx, userId, {
      type:  'rent_collected',
      title: 'Rent Collected 💰',
      body:  `₹${amount.toFixed(2)} added to your wallet from daily rent!`,
      data:  { amount: String(amount), balance_after: String(balanceAfter) },
    });

    logger.info(
      `[Rent] Collected ₹${amount} for user ${userId} | slot=${slotIndex} | balance_after=${balanceAfter}`
    );

    return {
      amount,
      balanceAfter,
      planName:    status.planName,
      slotIndex,
      windowLabel: _windowLabel(slotIndex),
    };
  });
}

module.exports = { getRentStatus, collectRent };