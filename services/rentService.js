// services/rentService.js
//
// Daily rent accumulation for users with active broadband plans.
//
// How it works:
//   • Each day, a user earns `daily_rent` (from plan column or price/validity_days).
//   • Rent is calculated on-demand (no cron needed) from lastCreditedAt.
//   • User can collect all pending rent once per day inside a configurable IST window.
//   • On collection, the rent amount is credited directly to their wallet.

const { db, sql }  = require('../config/db');
const notifyUser   = require('../utils/notifyUser');
const logger       = require('../utils/logger');

// ── Collection window (IST, 24-hour) ─────────────────────────────────────────
const WINDOW_START = parseInt(process.env.RENT_COLLECT_START_HOUR || '18', 10); // 6 PM
const WINDOW_END   = parseInt(process.env.RENT_COLLECT_END_HOUR   || '23', 10); // 11 PM

// ── IST helpers ───────────────────────────────────────────────────────────────

function _istNow() {
  // Convert UTC to IST (UTC+5:30)
  const now    = new Date();
  const ist    = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist;
}

function _istDateStr(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD in IST
}

function _isInCollectionWindow() {
  const ist = _istNow();

  const hours   = ist.getUTCHours();
  const minutes = ist.getUTCMinutes();

  const currentMinutes = hours * 60 + minutes;

  // 🔥 TEST WINDOW: 12:50 → 14:00
  const start = 12 * 60 + 50;  // 12:50
  const end   = 14 * 60;       // 2:00

  return currentMinutes >= start && currentMinutes <= end;
}
function _windowLabel() {
  return `12:50–14:00 IST`;
}

// ── Main: get rent status for a user ─────────────────────────────────────────

async function getRentStatus(userId) {
  // 1. Need an active subscription
  const sub = await db
    .selectFrom('dbo.user_subscriptions as s')
    .innerJoin('dbo.broadband_plans as p', 'p.id', 's.plan_id')
    .select([
      's.id as sub_id',
      's.start_date',
      's.expires_at',
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
      pendingRent:        0,
      totalCollected:     0,
      dailyRent:          0,
      canCollect:         false,
      collectedToday:     false,
      inCollectionWindow: false,
      windowLabel:        _windowLabel(),
      message:            'Purchase a plan to start earning daily rent.',
    };
  }

  // 2. Calculate per-day rent (plan column takes precedence; fallback = price/validity)
  const dailyRent = sub.daily_rent !== null && sub.daily_rent !== undefined
    ? parseFloat(sub.daily_rent)
    : parseFloat((parseFloat(sub.price) / sub.validity_days).toFixed(2));

  // 3. Fetch wallet row
  const wallet = await db
    .selectFrom('dbo.rent_wallets')
    .select(['id', 'pending_rent', 'total_collected', 'last_credited_at', 'last_collected_at'])
    .where('user_id', '=', BigInt(userId))
    .executeTakeFirst();

  // 4. Calculate accumulated rent since last credit
  const ist          = _istNow();
  const todayStr     = _istDateStr(ist);

  // Base date for accumulation: last credit OR subscription start date
  const baseDate     = wallet?.last_credited_at
    ? new Date(wallet.last_credited_at)
    : new Date(sub.start_date);

  const baseDateStr  = _istDateStr(new Date(baseDate.getTime() + 5.5 * 60 * 60 * 1000));
  const daysDiff     = Math.max(
    0,
    Math.floor((ist - new Date(baseDate.getTime() + 5.5 * 60 * 60 * 1000)) / (1000 * 60 * 60 * 24))
  );

  const storedPending   = parseFloat(wallet?.pending_rent || 0);
  const accumulatedRent = parseFloat((storedPending + daysDiff * dailyRent).toFixed(2));

  // 5. Check if already collected today (IST)
  const lastCollectedIST = wallet?.last_collected_at
    ? _istDateStr(new Date(new Date(wallet.last_collected_at).getTime() + 5.5 * 60 * 60 * 1000))
    : null;
  const collectedToday = lastCollectedIST === todayStr;

  const inWindow = _isInCollectionWindow();
  const canCollect = accumulatedRent > 0 && inWindow && !collectedToday;

  let message = null;
  if (!inWindow) {
    message = `Collect window: ${_windowLabel()}`;
  } else if (collectedToday) {
    message = 'Already collected today. Come back tomorrow!';
  }

  return {
    hasActivePlan:      true,
    planName:           sub.plan_name,
    dailyRent,
    pendingRent:        accumulatedRent,
    totalCollected:     parseFloat(wallet?.total_collected || 0),
    canCollect,
    collectedToday,
    inCollectionWindow: inWindow,
    windowLabel:        _windowLabel(),
    message,
  };
}

// ── Main: collect pending rent ─────────────────────────────────────────────────

async function collectRent(userId) {
  // Re-compute fresh status inside the transaction path
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

  const amount = status.pendingRent;

  if (amount <= 0) {
    throw Object.assign(
      new Error('No rent has accumulated yet. Check back after a day.'),
      { statusCode: 400 }
    );
  }

  const now = new Date();

  return db.transaction().execute(async (trx) => {
    // Lock wallet row
    const wallet = await trx
      .selectFrom('dbo.rent_wallets')
      .select(['id', 'last_collected_at'])
      .where('user_id', '=', BigInt(userId))
      .executeTakeFirst();

    // Double-check not already collected (race guard)
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

    // Read current wallet balance with row lock
    const userRow = await sql`
      SELECT wallet_balance FROM dbo.users WITH (UPDLOCK, ROWLOCK)
      WHERE id = ${BigInt(userId)}
    `.execute(trx).then(r => r.rows[0]);

    const balanceAfter = parseFloat(
      (parseFloat(userRow.wallet_balance) + amount).toFixed(2)
    );

    // 1. Credit wallet
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
          pending_rent:      '0',
          last_credited_at:  now,
          last_collected_at: now,
          total_collected:   sql`total_collected + ${amount}`,
          updated_at:        sql`SYSUTCDATETIME()`,
        })
        .where('id', '=', wallet.id)
        .execute();
    } else {
      await trx
        .insertInto('dbo.rent_wallets')
        .values({
          user_id:           BigInt(userId),
          pending_rent:      '0',
          total_collected:   String(amount),
          last_credited_at:  now,
          last_collected_at: now,
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
        reference_id:   String(userId), // user reference for auditing
      })
      .execute();

    // 4. Push notification
    await notifyUser(trx, userId, {
      type:  'rent_collected',
      title: 'Rent Collected 💰',
      body:  `₹${amount.toFixed(2)} added to your wallet from daily rent!`,
      data:  { amount: String(amount), balance_after: String(balanceAfter) },
    });

    logger.info(`[Rent] Collected ₹${amount} for user ${userId} | balance_after=${balanceAfter}`);

    return {
      amount,
      balanceAfter,
      planName:   status.planName,
    };
  });
}

module.exports = { getRentStatus, collectRent };