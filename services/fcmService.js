// services/fcmService.js
//
// Sends push notifications via Firebase Cloud Messaging (Admin SDK).
//
// Setup:
//   1. Firebase Console → Project Settings → Service Accounts
//   2. Generate new private key → save as firebase-service-account.json
//      in your project root
//   3. Add firebase-service-account.json to .gitignore
//   4. npm install firebase-admin

const admin  = require('firebase-admin');
const { db } = require('../config/db');
const logger = require('../utils/logger');

// ── Initialise once ───────────────────────────────────────────────────────────

let _initialised = false;

function _init() {
  if (_initialised) return;
  try {
    const serviceAccount = require('../firebase-service-account.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    _initialised = true;
    logger.info('[FCM] Firebase Admin SDK initialised ✓');
  } catch (err) {
    logger.warn(
      `[FCM] firebase-service-account.json not found — push disabled. ${err.message}`
    );
  }
}

_init();

// ── Send to one user ──────────────────────────────────────────────────────────

async function sendToUser(userId, { title, body, data = {} }) {
  if (!_initialised) return;

  try {
    const row = await db
      .selectFrom('dbo.users')
      .select('fcm_token')
      .where('id', '=', BigInt(userId))
      .executeTakeFirst();

    const token = row?.fcm_token;
    if (!token) {
      logger.debug(`[FCM] No token for user ${userId} — skipping push`);
      return;
    }

    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        notification: {
          channelId: 'speedonet_channel',
          priority:  'high',
          sound:     'default',
        },
        priority: 'high',
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    };

    const response = await admin.messaging().send(message);
    logger.info(`[FCM] Sent to user ${userId} | messageId=${response}`);

  } catch (err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      logger.warn(`[FCM] Stale token for user ${userId} — clearing`);
      await _clearToken(userId).catch(() => {});
    } else {
      logger.error(`[FCM] Failed for user ${userId}: ${err.message}`);
    }
  }
}

// ── Send to multiple users ────────────────────────────────────────────────────

async function sendToUsers(userIds, { title, body, data = {} }) {
  await Promise.allSettled(
    userIds.map(id => sendToUser(id, { title, body, data }))
  );
}

// ── Broadcast to all active users ────────────────────────────────────────────

async function broadcast({ title, body, data = {} }) {
  if (!_initialised) return;

  try {
    const rows = await db
      .selectFrom('dbo.users')
      .select(['id', 'fcm_token'])
      .where('is_active',  '=', true)
      .where('fcm_token', 'is not', null)
      .execute();

    if (rows.length === 0) return;

    // FCM multicast: max 500 tokens per call
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);

      const msg = {
        tokens: chunk.map(r => r.fcm_token),
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        android: {
          notification: { channelId: 'speedonet_channel', priority: 'high' },
          priority: 'high',
        },
      };

      const result = await admin.messaging().sendEachForMulticast(msg);
      logger.info(`[FCM] Broadcast chunk: ${result.successCount} sent, ${result.failureCount} failed`);

      // Log individual failures to identify error codes
      result.responses.forEach((r, j) => {
        if (!r.success) {
          logger.error(`[FCM] Token[${j}] user=${chunk[j].id} error=${r.error?.code} msg=${r.error?.message}`);
        }
      });

      // Clear stale/invalid tokens so they don't clog future broadcasts
      if (result.failureCount > 0) {
        const staleIds = result.responses
          .map((r, j) => ({ ...r, userId: chunk[j].id }))
          .filter(r => !r.success && [
            'messaging/registration-token-not-registered',
            'messaging/invalid-registration-token',
            'messaging/invalid-argument',
          ].includes(r.error?.code))
          .map(r => r.userId);

        if (staleIds.length > 0) {
          await db.updateTable('dbo.users')
            .set({ fcm_token: null })
            .where('id', 'in', staleIds)
            .execute();
          logger.warn(`[FCM] Cleared ${staleIds.length} stale token(s)`);
        }
      }
    }
  } catch (err) {
    logger.error(`[FCM] Broadcast failed: ${err.message}`);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

async function saveToken(userId, token) {
  try {
    await db
      .updateTable('dbo.users')
      .set({ fcm_token: token || null, updated_at: new Date() })
      .where('id', '=', BigInt(userId))
      .execute();
    logger.debug(`[FCM] Token saved for user ${userId}`);
  } catch (err) {
    logger.error(`[FCM] saveToken failed: ${err.message}`);
  }
}

async function _clearToken(userId) {
  await db
    .updateTable('dbo.users')
    .set({ fcm_token: null })
    .where('id', '=', BigInt(userId))
    .execute();
}

module.exports = { sendToUser, sendToUsers, broadcast, saveToken };