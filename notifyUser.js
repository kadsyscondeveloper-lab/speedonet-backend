// utils/notifyUser.js
//
// Single helper that:
//   1. Saves the notification to dbo.notifications (existing behaviour)
//   2. Fires a push notification via FCM (new behaviour)
//
// Replace every db.insertInto('dbo.notifications') call with notifyUser().
// Existing behaviour is 100% preserved — FCM is additive and silent-fails.
//
// Usage:
//   const notifyUser = require('../utils/notifyUser');
//
//   // Inside a transaction (pass trx):
//   await notifyUser(trx, userId, {
//     type:  'plan_activated',
//     title: 'Plan Activated 🎉',
//     body:  'Your plan is active until ...',
//   });
//
//   // Outside a transaction (pass db):
//   await notifyUser(db, userId, {
//     type:  'wallet_recharge',
//     title: 'Wallet Recharged 💰',
//     body:  '₹500 added to your wallet.',
//   });

const { sendToUser } = require('../services/fcmService');
const logger         = require('./logger');

async function notifyUser(trxOrDb, userId, { type, title, body, deepLink = null, data = {} }) {
  // 1. Save to DB (always)
  try {
    await trxOrDb
      .insertInto('dbo.notifications')
      .values({
        user_id:   BigInt(userId),
        type,
        title,
        body,
        deep_link: deepLink,
      })
      .execute();
  } catch (err) {
    logger.error(`[notifyUser] DB insert failed for user ${userId}: ${err.message}`);
  }

  // 2. Fire push notification (non-blocking — never throws)
  sendToUser(userId, {
    title,
    body,
    data: { type, deep_link: deepLink ?? '', ...data },
  }).catch(err => {
    logger.error(`[notifyUser] FCM failed for user ${userId}: ${err.message}`);
  });
}

module.exports = notifyUser;
