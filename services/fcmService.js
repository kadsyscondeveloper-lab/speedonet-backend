// services/fcmService.js
//
// Multi-device FCM support — one token per device, stored in dbo.fcm_tokens.
// Previously a single fcm_token column on dbo.users meant only the last
// logged-in device received pushes. Now every device gets notifications.

const admin  = require('firebase-admin');
const { db, sql } = require('../config/db');
const logger = require('../utils/logger');

// ── Initialise once ───────────────────────────────────────────────────────────

let _initialised = false;

function _init() {
  if (_initialised) return;
  try {
    const serviceAccount = require('../firebase-service-account.json');

    if (!serviceAccount.private_key || !serviceAccount.client_email) {
      throw new Error('Service account JSON is missing private_key or client_email');
    }

    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    _initialised = true;
    logger.info('[FCM] Firebase Admin SDK initialised ✓');
  } catch (err) {
    logger.error(`[FCM] Init failed — push notifications disabled: ${err.message}`);
  }
}

_init();

// ── Stale token error codes ───────────────────────────────────────────────────

const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/invalid-recipient',
  'messaging/third-party-auth-error',
]);

// ── Send to one user (all their devices) ─────────────────────────────────────

async function sendToUser(userId, { title, body, data = {} }) {
  if (!_initialised) {
    logger.warn('[FCM] SDK not initialised — skipping push');
    return;
  }

  try {
    const rows = await db
      .selectFrom('dbo.fcm_tokens')
      .select(['id', 'token'])
      .where('user_id', '=', BigInt(userId))
      .execute();

    if (rows.length === 0) {
      logger.debug(`[FCM] No tokens for user ${userId} — skipping push`);
      return;
    }

    logger.debug(`[FCM] Sending to user ${userId} on ${rows.length} device(s)`);

    const dataStrings = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );

    const staleIds = [];

    await Promise.allSettled(rows.map(async (row) => {
      try {
        const message = {
          token: row.token,
          notification: { title, body },
          data: dataStrings,
          android: {
            notification: {
              channelId: 'speedonet_channel',
              priority:  'high',
              sound:     'default',
            },
            priority: 'high',
          },
          apns: {
            payload: {
              aps: {
                sound:            'default',
                badge:            1,
                contentAvailable: true,
              },
            },
            headers: { 'apns-priority': '10' },
          },
        };

        const result = await admin.messaging().sendEachForMulticast({
        tokens: [row.token],
        notification: { title, body },
        data: dataStrings,
        android: message.android,
        apns: message.apns,
      });

      const r = result.responses[0];

      if (!r.success) {
        logger.error(`[FCM FAIL] user=${userId} device=${row.id}`);
        logger.error(`code=${r.error?.code}`);
        logger.error(`message=${r.error?.message}`);
      } else {
        logger.info(`[FCM OK] user=${userId} device=${row.id} messageId=${r.messageId}`);
      }
            } catch (err) {
        logger.error(`[FCM ERROR] user=${userId} device=${row.id}`);
  logger.error(`code=${err.code}`);
  logger.error(`message=${err.message}`);
  logger.error(`full=`, err);

  if (STALE_TOKEN_CODES.has(err.code)) {
    logger.warn(`[FCM] Stale token id=${row.id} user=${userId} (${err.code}) — queued for removal`);
    staleIds.push(row.id);
  }
      }
    }));

    if (staleIds.length > 0) {
      await db.deleteFrom('dbo.fcm_tokens')
        .where('id', 'in', staleIds)
        .execute();
      logger.warn(`[FCM] Removed ${staleIds.length} stale token(s) for user ${userId}`);
    }

  } catch (err) {
    logger.error(`[FCM] sendToUser failed for user ${userId}: ${err.message}`);
  }
}

// ── Send to multiple users ────────────────────────────────────────────────────

async function sendToUsers(userIds, { title, body, data = {} }) {
  await Promise.allSettled(
    userIds.map(id => sendToUser(id, { title, body, data }))
  );
}

// ── Broadcast to all active users ─────────────────────────────────────────────

async function broadcast({ title, body, data = {} }) {
  if (!_initialised) {
    logger.warn('[FCM] SDK not initialised — skipping broadcast');
    return;
  }

  try {
    const rows = await sql`
      SELECT ft.id, ft.token, ft.user_id
      FROM dbo.fcm_tokens ft
      INNER JOIN dbo.users u ON u.id = ft.user_id
      WHERE u.is_active = 1
    `.execute(db).then(r => r.rows);

    if (rows.length === 0) {
      logger.info('[FCM] Broadcast: no devices with FCM tokens');
      return;
    }

    logger.info(`[FCM] Broadcasting to ${rows.length} device(s)`);

    const dataStrings = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);

      const msg = {
        tokens: chunk.map(r => r.token),
        notification: { title, body },
        data: dataStrings,
        android: {
          notification: {
            channelId: 'speedonet_channel',
            priority:  'high',
            sound:     'default',
          },
          priority: 'high',
        },
        apns: {
          payload: {
            aps: { sound: 'default', badge: 1, contentAvailable: true },
          },
          headers: { 'apns-priority': '10' },
        },
      };

      const result = await admin.messaging().sendEachForMulticast(msg);
      logger.info(`[FCM] Broadcast chunk ${Math.floor(i / 500) + 1}: ${result.successCount} sent, ${result.failureCount} failed`);

      result.responses.forEach((r, j) => {
        if (!r.success) {
          logger.warn(`[FCM] Broadcast fail | user=${chunk[j].user_id} device=${chunk[j].id} code=${r.error?.code}`);
        }
      });

      if (result.failureCount > 0) {
        const staleIds = result.responses
          .map((r, j) => ({ ...r, id: chunk[j].id }))
          .filter(r => !r.success && STALE_TOKEN_CODES.has(r.error?.code))
          .map(r => r.id);

        if (staleIds.length > 0) {
          await db.deleteFrom('dbo.fcm_tokens')
            .where('id', 'in', staleIds)
            .execute();
          logger.warn(`[FCM] Broadcast: removed ${staleIds.length} stale token(s)`);
        }
      }
    }
  } catch (err) {
    logger.error(`[FCM] Broadcast failed: ${err.message}`);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

async function saveToken(userId, token) {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    logger.warn(`[FCM] saveToken called with invalid token for user ${userId}`);
    return;
  }

  try {
    const existing = await db
      .selectFrom('dbo.fcm_tokens')
      .select(['id', 'user_id'])
      .where('token', '=', token)
      .executeTakeFirst();

    if (existing) {
      if (Number(existing.user_id) === Number(userId)) {
        logger.debug(`[FCM] Token already registered for user ${userId}`);
        return;
      }
      // Shared device — reassign token to new user
      await db
        .updateTable('dbo.fcm_tokens')
        .set({ user_id: BigInt(userId), updated_at: new Date() })
        .where('id', '=', existing.id)
        .execute();
      logger.info(`[FCM] Token reassigned from user ${existing.user_id} to user ${userId}`);
    } else {
      await db
        .insertInto('dbo.fcm_tokens')
        .values({ user_id: BigInt(userId), token })
        .execute();
      logger.info(`[FCM] New token registered for user ${userId}`);
    }
  } catch (err) {
    logger.error(`[FCM] saveToken failed for user ${userId}: ${err.message}`);
  }
}

async function clearToken(userId, token) {
  try {
    if (token) {
      await db
        .deleteFrom('dbo.fcm_tokens')
        .where('user_id', '=', BigInt(userId))
        .where('token', '=', token)
        .execute();
      logger.info(`[FCM] Token cleared for user ${userId} (this device only)`);
    } else {
      await db
        .deleteFrom('dbo.fcm_tokens')
        .where('user_id', '=', BigInt(userId))
        .execute();
      logger.info(`[FCM] All tokens cleared for user ${userId}`);
    }
  } catch (err) {
    logger.error(`[FCM] clearToken failed for user ${userId}: ${err.message}`);
  }
}

module.exports = { sendToUser, sendToUsers, broadcast, saveToken, clearToken };