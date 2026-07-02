/**
 * firebase_admin.js — init Firebase Admin SDK
 * Taruh di root be-sm-mobile/, sejajar server.js
 *
 * Butuh: npm install firebase-admin
 *
 * Taruh file sm-mobile-djalu-firebase-adminsdk-fbsvc-xxx.json
 * di folder yang SAMA, lalu rename jadi: firebase-service-account.json
 * (atau sesuaikan path di bawah)
 */

const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/**
 * Kirim push notification ke 1 device via FCM token
 */
async function sendPushToToken(token, title, body, data = {}) {
  if (!token) return null;
  try {
    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: 'cad_channel',
          sound: 'default',
        },
      },
    };
    const res = await admin.messaging().send(message);
    console.log('[FCM] Sent:', res);
    return res;
  } catch (e) {
    console.error('[FCM] Error:', e.message);
    return null;
  }
}

/**
 * Kirim ke banyak token sekaligus (misal semua backoffice)
 */
async function sendPushToMultiple(tokens, title, body, data = {}) {
  const valid = tokens.filter(Boolean);
  if (valid.length === 0) return null;
  try {
    const message = {
      tokens: valid,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: { channelId: 'cad_channel', sound: 'default' },
      },
    };
    const res = await admin.messaging().sendEachForMulticast(message);
    console.log(`[FCM] Sent to ${res.successCount}/${valid.length}`);
    return res;
  } catch (e) {
    console.error('[FCM] Multi error:', e.message);
    return null;
  }
}

module.exports = { admin, sendPushToToken, sendPushToMultiple };