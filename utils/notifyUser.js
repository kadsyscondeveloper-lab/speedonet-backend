// utils/notifyUser.js
//
// Single helper that:
//   1. Saves the notification to dbo.notifications (DB — always)
//   2. Fires a push notification via FCM (push — silent fail if no token)
//
// Usage inside a transaction:
//   await notifyUser(trx, userId, { type, title, body });
//
// Usage outside a transaction:
//   const { db } = require('../config/db');
//   await notifyUser(db, userId, { type, title, body });

const { sendToUser } = require('../services/fcmService');
const logger         = require('./logger');

async function notifyUser(trxOrDb, userId, {
  type,
  title,
  body,
  deepLink = null,
  data     = {},
}) {
  // ── 1. Always save to DB ──────────────────────────────────────────────────
  try {
    await trxOrDb
      .insertInto('dbo.notifications')
      .values({
        user_id:   BigInt(userId),
        type,
        title,
        body,
        deep_link: deepLink ?? null,
      })
      .execute();
  } catch (err) {
    logger.error(`[notifyUser] DB insert failed for user ${userId}: ${err.message}`);
  }

  // ── 2. Send push (non-blocking — never throws) ────────────────────────────
  sendToUser(userId, {
    title,
    body,
    data: {
      type,
      deep_link: deepLink ?? '',
      ...data,
    },
  }).catch(err => {
    logger.error(`[notifyUser] FCM failed for user ${userId}: ${err.message}`);
  });
}

module.exports = notifyUser;