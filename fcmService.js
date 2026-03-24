// services/fcmService.js
//
// Sends push notifications via Firebase Cloud Messaging (Admin SDK).
//
// Setup:
//   1. Go to Firebase Console → Project Settings → Service Accounts
//   2. Click "Generate new private key" → download the JSON file
//   3. Save it as firebase-service-account.json in your project root
//   4. Add firebase-service-account.json to .gitignore (never commit it)
//   5. npm install firebase-admin

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
    // If file missing, FCM is disabled but app still runs
    logger.warn(`[FCM] firebase-service-account.json not found — push notifications disabled. ${err.message}`);
  }
}

_init();

// ── Send to one user ──────────────────────────────────────────────────────────
//
// Looks up the user's FCM token from DB and sends the notification.
// Silent fail — if token missing or FCM errors, we just log it.

async function sendToUser(userId, { title, body, data = {} }) {
  if (!_initialised) return;

  try {
    // Get FCM token for this user
    const row = await db
      .selectFrom('dbo.users')
      .select('fcm_token')
      .where('id', '=', BigInt(userId))
      .executeTakeFirst();

    const token = row?.fcm_token;
    if (!token) {
      logger.debug(`[FCM] No FCM token for user ${userId} — skipping push`);
      return;
    }

    const message = {
      token,
      notification: { title, body },
      data: {
        // All data values must be strings for FCM
        ...Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
      },
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
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    logger.info(`[FCM] Sent to user ${userId} | messageId=${response}`);

  } catch (err) {
    // Token expired / app uninstalled → clean it up
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      logger.warn(`[FCM] Stale token for user ${userId} — clearing`);
      await _clearToken(userId);
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

// ── Broadcast to all users ────────────────────────────────────────────────────

async function broadcast({ title, body, data = {} }) {
  if (!_initialised) return;

  try {
    const rows = await db
      .selectFrom('dbo.users')
      .select(['id', 'fcm_token'])
      .where('is_active', '=', true)
      .whereNotNull('fcm_token')  // only users with a token
      .execute();

    const tokens = rows.map(r => r.fcm_token).filter(Boolean);
    if (tokens.length === 0) return;

    // FCM supports up to 500 tokens per multicast call
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) {
      chunks.push(tokens.slice(i, i + 500));
    }

    for (const chunk of chunks) {
      const message = {
        tokens: chunk,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        android: {
          notification: { channelId: 'speedonet_channel', priority: 'high' },
          priority: 'high',
        },
      };
      const response = await admin.messaging().sendEachForMulticast(message);
      logger.info(`[FCM] Broadcast: ${response.successCount} sent, ${response.failureCount} failed`);
    }
  } catch (err) {
    logger.error(`[FCM] Broadcast failed: ${err.message}`);
  }
}

// ── Save / clear token ────────────────────────────────────────────────────────

async function saveToken(userId, token) {
  try {
    await db
      .updateTable('dbo.users')
      .set({ fcm_token: token, updated_at: db.raw('SYSUTCDATETIME()') })
      .where('id', '=', BigInt(userId))
      .execute();
    logger.debug(`[FCM] Token saved for user ${userId}`);
  } catch (err) {
    logger.error(`[FCM] saveToken failed: ${err.message}`);
  }
}

async function _clearToken(userId) {
  try {
    await db
      .updateTable('dbo.users')
      .set({ fcm_token: null })
      .where('id', '=', BigInt(userId))
      .execute();
  } catch (_) {}
}

module.exports = { sendToUser, sendToUsers, broadcast, saveToken };
