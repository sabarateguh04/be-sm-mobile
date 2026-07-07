/* firebase-messaging-sw.js
 * Service worker buat terima FCM push waktu tab SM Dispatcher tidak fokus /
 * browser di-minimize. HARUS ada di root (bukan di dalam sub-folder) supaya
 * scope-nya mencakup seluruh origin.
 *
 * Isi firebaseConfig di bawah PERSIS SAMA seperti FIREBASE_WEB_CONFIG di
 * public/index.html — kalau tidak sama, token FCM tidak akan terbentuk.
 * Ambil dari Firebase Console → Project Settings → General → Your apps → Web app.
 */

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'ISI_DARI_FIREBASE_CONSOLE',
  authDomain: 'sm-mobile-djalu.firebaseapp.com',
  projectId: 'sm-mobile-djalu',
  storageBucket: 'sm-mobile-djalu.appspot.com',
  messagingSenderId: '1079913631425',
  appId: 'ISI_DARI_FIREBASE_CONSOLE',
});

const messaging = firebase.messaging();

// Tampilkan notifikasi sistem waktu push masuk dan tab sedang di-background.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'SM Dispatcher';
  const body  = payload.notification?.body || '';
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png', // opsional, ganti/hapus kalau belum ada asetnya
    data: payload.data || {},
  });
});

// Klik notifikasi → fokus/buka tab dashboard
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    }),
  );
});