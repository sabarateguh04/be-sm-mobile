/**
 * firebase_admin.js
 */

let admin;
let messaging;

try {
  // firebase-admin v12+ pakai named import
  const firebaseAdmin = require('firebase-admin/app');
  const firebaseMessaging = require('firebase-admin/messaging');
  const serviceAccount = require('./firebase-service-account.json');

  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.cert(serviceAccount),
  });

  admin = firebaseAdmin;
  messaging = firebaseMessaging.getMessaging();
  console.log('[FIREBASE] Initialized with v12+ API');
} catch (e1) {
  try {
    // Fallback: firebase-admin v11 dan sebelumnya
    const fb = require('firebase-admin');
    const serviceAccount = require('./firebase-service-account.json');
    fb.initializeApp({
      credential: fb.credential.cert(serviceAccount),
    });
    admin = fb;
    messaging = fb.messaging();
    console.log('[FIREBASE] Initialized with legacy API');
  } catch (e2) {
    console.error('[FIREBASE] Init failed:', e2.message);
  }
}

async function sendPushToToken(token, title, body, data = {}) {
  if (!token || !messaging) return null;
  try {
    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: { channelId: 'cad_channel', sound: 'default' },
      },
    };
    const res = await messaging.send(message);
    console.log('[FCM] Sent:', res);
    return res;
  } catch (e) {
    console.error('[FCM] Error:', e.message);
    return null;
  }
}

async function sendPushToMultiple(tokens, title, body, data = {}) {
  const valid = tokens.filter(Boolean);
  if (valid.length === 0 || !messaging) return null;
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
    const res = await messaging.sendEachForMulticast(message);
    console.log(`[FCM] Sent to ${res.successCount}/${valid.length}`);
    return res;
  } catch (e) {
    console.error('[FCM] Multi error:', e.message);
    return null;
  }
}

module.exports = { sendPushToToken, sendPushToMultiple };