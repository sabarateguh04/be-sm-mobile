const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const bcrypt  = require('bcryptjs');
const pool    = require('./db');
require('dotenv').config();

const { initSocket, emitToBackoffice } = require('./socket');
const { sendPushToMultiple } = require('./firebase_admin');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Dashboard SM Dispatcher (web backoffice) — taruh file di folder /public
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════
   HELPER
═══════════════════════════════════════ */
function nowDatetime() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function formatDatetime(val) {
  if (!val) return '';
  return new Date(val).toISOString().slice(0, 19).replace('T', ' ');
}
function response(res, code, data) {
  return res.status(code).json(data);
}

/* ═══════════════════════════════════════
   1. LOGIN
═══════════════════════════════════════ */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return response(res, 400, { message: 'Username dan password wajib diisi' });

  try {
    const [rows] = await pool.query(
      `SELECT user_id, username, nama, password FROM tbl_petugas_mobile
       WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username]
    );

    if (rows.length === 0)
      return response(res, 401, { message: 'Username atau password salah' });

    const user = rows[0];
    if (user.password !== password)
      return response(res, 401, { message: 'Username atau password salah' });

    return response(res, 200, {
      userId:   user.user_id,
      username: user.username,
      nama:     user.nama,
    });
  } catch (e) {
    console.error('[LOGIN]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   1b. BACKOFFICE REGISTER
   POST /api/backoffice/register
   body: { username, password, nama }
═══════════════════════════════════════ */
app.post('/api/backoffice/register', async (req, res) => {
  const { username, password, nama } = req.body;

  if (!username || !password || !nama)
    return response(res, 400, { message: 'Username, password, dan nama wajib diisi' });
  if (password.length < 6)
    return response(res, 400, { message: 'Password minimal 6 karakter' });

  try {
    const [existing] = await pool.query(
      `SELECT user_id FROM tbl_backoffice_user WHERE username = ? LIMIT 1`,
      [username]
    );
    if (existing.length > 0)
      return response(res, 409, { message: 'Username sudah dipakai' });

    const hashed = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `INSERT INTO tbl_backoffice_user (username, password, nama, is_active)
       VALUES (?, ?, ?, 1)`,
      [username, hashed, nama]
    );

    return response(res, 201, {
      message:  'Registrasi berhasil',
      userId:   result.insertId,
      username,
      nama,
    });
  } catch (e) {
    console.error('[BACKOFFICE-REGISTER]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   1c. BACKOFFICE LOGIN
   POST /api/backoffice/login
   body: { username, password }
═══════════════════════════════════════ */
app.post('/api/backoffice/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return response(res, 400, { message: 'Username dan password wajib diisi' });

  try {
    const [rows] = await pool.query(
      `SELECT user_id, username, password, nama FROM tbl_backoffice_user
       WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username]
    );

    if (rows.length === 0)
      return response(res, 401, { message: 'Username atau password salah' });

    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return response(res, 401, { message: 'Username atau password salah' });

    return response(res, 200, {
      userId:   user.user_id,
      username: user.username,
      nama:     user.nama,
    });
  } catch (e) {
    console.error('[BACKOFFICE-LOGIN]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   2. PROFILE
═══════════════════════════════════════ */
app.get('/api/profile', async (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return response(res, 400, { message: 'userId wajib diisi' });

  try {
    const [rows] = await pool.query(
      `SELECT user_id, nama, url_image, lat, lng, status, last_updated
       FROM tbl_petugas_mobile WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    if (rows.length === 0)
      return response(res, 404, { message: 'Petugas tidak ditemukan' });

    const u = rows[0];
    return response(res, 200, {
      userId:       u.user_id,
      nama:         u.nama,
      url_image:    u.url_image || '',
      lat:          parseFloat(u.lat) || 0,
      lng:          parseFloat(u.lng) || 0,
      status:       u.status || 'OFFLINE',
      last_updated: formatDatetime(u.last_updated),
    });
  } catch (e) {
    console.error('[PROFILE]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   3. UPDATE LOCATION
═══════════════════════════════════════ */
app.post('/api/update-location', async (req, res) => {
  const { userId, lat, lng, ctddate, ctdtime, status } = req.body;

  if (!userId || lat == null || lng == null || !ctddate || !ctdtime || !status)
    return response(res, 400, { message: 'Semua field wajib diisi' });

  const validStatus = ['ONLINE', 'BERTUGAS', 'OFFLINE'];
  if (!validStatus.includes(status))
    return response(res, 400, { message: 'Status tidak valid' });

  const datetime = `${ctddate} ${ctdtime}`;

  try {
    await pool.query(
      `INSERT INTO tbl_location_log_mobile (user_id, lat, lng, ctddate, ctdtime, datetime, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, lat, lng, ctddate, ctdtime, datetime, status]
    );

    await pool.query(
      `UPDATE tbl_petugas_mobile SET lat = ?, lng = ?, status = ?, last_updated = ? WHERE user_id = ?`,
      [lat, lng, status, datetime, userId]
    );

    // Broadcast ke semua backoffice yang lagi buka halaman Pemantauan,
    // supaya pin di peta gerak realtime tanpa nunggu polling.
    emitToBackoffice('petugas-location', { userId, lat, lng, status, last_updated: datetime });

    return response(res, 200, { ket: 'data berhasil di update' });
  } catch (e) {
    console.error('[UPDATE-LOCATION]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   4. UPDATE PROFILE
═══════════════════════════════════════ */
app.post('/api/update-profile', async (req, res) => {
  const { userId, lat, lng, status, last_updated } = req.body;

  if (!userId || lat == null || lng == null || !status || !last_updated)
    return response(res, 400, { message: 'Semua field wajib diisi' });

  try {
    await pool.query(
      `UPDATE tbl_petugas_mobile SET lat = ?, lng = ?, status = ?, last_updated = ? WHERE user_id = ?`,
      [lat, lng, status, last_updated, userId]
    );

    emitToBackoffice('petugas-location', { userId, lat, lng, status, last_updated });

    return response(res, 200, { ket: 'data berhasil di update' });
  } catch (e) {
    console.error('[UPDATE-PROFILE]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   5. SAVE FCM TOKEN
   POST /api/save-fcm-token
   body: { userId, fcmToken, role }  → role: 'petugas' | 'backoffice'
═══════════════════════════════════════ */
app.post('/api/save-fcm-token', async (req, res) => {
  const { userId, fcmToken, role = 'petugas', nama } = req.body;
  if (!userId || !fcmToken)
    return response(res, 400, { message: 'userId & fcmToken wajib' });

  try {
    // 1 device (fcm_token) cuma boleh aktif untuk 1 akun dalam satu waktu.
    // Kalau device ini sebelumnya kepakai user lain (mis. logout lalu login
    // user baru tanpa uninstall), lepas dulu token itu dari baris lama —
    // di kedua tabel, jaga-jaga kalau device pernah dipakai lintas role —
    // supaya user lama tidak ikut kebagian notif dari device yang sama.
    await pool.query(
      `UPDATE tbl_petugas_mobile SET fcm_token = NULL WHERE fcm_token = ? AND user_id != ?`,
      [fcmToken, userId],
    );
    await pool.query(
      `UPDATE tbl_backoffice_user SET fcm_token = NULL WHERE fcm_token = ? AND user_id != ?`,
      [fcmToken, userId],
    );

    if (role === 'backoffice') {
      // tbl_backoffice_user punya username & password NOT NULL, jadi baris
      // user backoffice cuma boleh dibuat lewat /api/backoffice/register.
      // Di sini kita cuma update fcm_token untuk user yang sudah terdaftar.
      await pool.query(
        `UPDATE tbl_backoffice_user SET fcm_token = ? WHERE user_id = ?`,
        [fcmToken, userId],
      );
    } else {
      await pool.query(
        `UPDATE tbl_petugas_mobile SET fcm_token = ? WHERE user_id = ?`,
        [fcmToken, userId],
      );
    }
    return response(res, 200, { message: 'Token tersimpan' });
  } catch (e) {
    console.error('[SAVE-FCM-TOKEN]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   ROUTES
═══════════════════════════════════════ */
const cadRoute        = require('./cad.route');
const backofficeRoute = require('./backoffice.route');

app.use('/api/cad',        cadRoute);
app.use('/api/backoffice', backofficeRoute);

/* ═══════════════════════════════════════
   HEALTH CHECK
═══════════════════════════════════════ */
app.get('/health', (_, res) => res.json({ status: 'ok', time: nowDatetime() }));

/* ═══════════════════════════════════════
   WATCHDOG — jalan tiap 1 menit
   1) Petugas status ONLINE tapi udah ≥15 menit gak kirim update
      lokasi (app ditutup paksa / device mati tanpa logout resmi,
      jadi endpoint logout gak sempat kepanggil) → paksa jadi OFFLINE.
   2) Petugas status BERTUGAS (masih ada task yg belum SELESAI)
      DIBIARKAN — gak ikut auto-offline. Sebagai gantinya, kirim
      reminder ke backoffice tiap 15 menit selama task itu belum kelar.

   ⚠️ CATATAN PENTING: perbandingan waktu di sini pakai
   TIMESTAMPDIFF(MINUTE, last_updated, NOW()) — artinya nilai
   last_updated (dikirim dari HP petugas) HARUS di jam yang sama
   dengan jam server MySQL kamu. Kalau HP kirim jam WIB tapi server
   MySQL jalan di UTC (atau sebaliknya), auto-offline ini bisa gak
   akurat (telat/gak pernah kepicu, atau kepicu instan). Kalau itu
   terjadi, kabari saya jam device vs jam server-nya beda berapa jam.
═══════════════════════════════════════ */
const IDLE_OFFLINE_MINUTES  = 15;
const TASK_REMINDER_MINUTES = 15;
const taskReminderLastSent  = new Map(); // key: `${task_id}:${user_id}` → timestamp ms terakhir diingatkan

async function runPetugasWatchdog() {
  // 1) Auto-OFFLINE untuk petugas ONLINE yang diem >= 15 menit
  try {
    const [stale] = await pool.query(
      `SELECT user_id, nama FROM tbl_petugas_mobile
       WHERE status = 'ONLINE'
         AND last_updated IS NOT NULL
         AND TIMESTAMPDIFF(MINUTE, last_updated, NOW()) >= ?`,
      [IDLE_OFFLINE_MINUTES],
    );
    for (const p of stale) {
      await pool.query(`UPDATE tbl_petugas_mobile SET status = 'OFFLINE' WHERE user_id = ?`, [p.user_id]);
      emitToBackoffice('petugas-location', { userId: p.user_id, status: 'OFFLINE' });
      console.log(`[WATCHDOG] ${p.nama} (#${p.user_id}) auto-OFFLINE — idle ${IDLE_OFFLINE_MINUTES}+ menit`);
    }
  } catch (e) {
    console.error('[WATCHDOG offline]', e.message);
  }

  // 2) Reminder buat task yang masih berjalan (petugas BERTUGAS, belum SELESAI)
  try {
    const [ongoing] = await pool.query(
      `SELECT a.task_id, a.user_id, p.nama, t.title
       FROM tbl_cad_assignment a
       JOIN tbl_petugas_mobile p ON p.user_id = a.user_id
       JOIN tbl_cad_task t       ON t.id = a.task_id
       WHERE a.status IN ('DITERIMA','MENUJU','TIBA')`,
    );

    const activeKeys = new Set();
    for (const row of ongoing) {
      const key = `${row.task_id}:${row.user_id}`;
      activeKeys.add(key);

      if (!taskReminderLastSent.has(key)) {
        // Baru ketauan lagi jalan — jangan langsung ngingetin, mulai hitung dari sekarang
        taskReminderLastSent.set(key, Date.now());
        continue;
      }
      const elapsedMin = (Date.now() - taskReminderLastSent.get(key)) / 60000;
      if (elapsedMin < TASK_REMINDER_MINUTES) continue;

      taskReminderLastSent.set(key, Date.now());
      const message = `${row.nama} masih menangani "${row.title}" — belum selesai.`;

      emitToBackoffice('task-reminder', {
        taskId: row.task_id, userId: row.user_id, nama: row.nama, title: row.title, message,
      });

      try {
        const [boRows] = await pool.query(`SELECT fcm_token FROM tbl_backoffice_user WHERE fcm_token IS NOT NULL`);
        const tokens = boRows.map(r => r.fcm_token).filter(Boolean);
        if (tokens.length > 0) {
          await sendPushToMultiple(tokens, 'Tugas Belum Selesai', message, {
            type: 'task_reminder', taskId: String(row.task_id),
          });
        }
      } catch (pushErr) {
        console.error('[WATCHDOG push]', pushErr.message);
      }
    }

    // Buang key yang task-nya udah kelar/gak aktif lagi, biar Map gak numpuk terus
    for (const key of taskReminderLastSent.keys()) {
      if (!activeKeys.has(key)) taskReminderLastSent.delete(key);
    }
  } catch (e) {
    console.error('[WATCHDOG reminder]', e.message);
  }
}
setInterval(runPetugasWatchdog, 60 * 1000);

/* ═══════════════════════════════════════
   HTTP SERVER + SOCKET.IO
═══════════════════════════════════════ */
const httpServer = http.createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`🚀 GPS Backend + Socket.IO running at http://localhost:${PORT}`);
  console.log(`📋 Mobile Endpoints:`);
  console.log(`   POST /api/login`);
  console.log(`📋 Backoffice Auth Endpoints:`);
  console.log(`   POST /api/backoffice/register`);
  console.log(`   POST /api/backoffice/login`);
  console.log(`   GET  /api/profile?userId=1`);
  console.log(`   POST /api/update-location`);
  console.log(`   POST /api/update-profile`);
  console.log(`   POST /api/save-fcm-token`);
  console.log(`📋 CAD Mobile Endpoints:`);
  console.log(`   GET  /api/cad/my-task?userId=1`);
  console.log(`   GET  /api/cad/task-detail?taskId=1`);
  console.log(`   GET  /api/cad/stats?userId=1`);
  console.log(`   POST /api/cad/terima-task`);
  console.log(`   POST /api/cad/menuju`);
  console.log(`   POST /api/cad/tiba`);
  console.log(`   POST /api/cad/selesai`);
  console.log(`   POST /api/cad/upload-photo`);
  console.log(`📋 Backoffice Endpoints:`);
  console.log(`   GET  /api/backoffice/dashboard`);
  console.log(`   GET  /api/backoffice/list-petugas`);
  console.log(`   GET  /api/backoffice/map-data`);
  console.log(`   GET  /api/backoffice/all-task`);
  console.log(`   GET  /api/backoffice/task-detail?taskId=1`);
  console.log(`   POST /api/backoffice/create-task`);
  console.log(`   POST /api/backoffice/assign-task`);
  console.log(`   POST /api/backoffice/close-task`);
  console.log(`🔌 Socket.IO aktif untuk realtime update`);
  console.log(`🐕 Watchdog aktif: auto-offline (${IDLE_OFFLINE_MINUTES} menit idle) + reminder task berjalan (tiap ${TASK_REMINDER_MINUTES} menit)`);
  console.log(`   GET  /health`);
});