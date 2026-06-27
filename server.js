const express = require('express');
const cors    = require('cors');
const path    = require('path');
const pool    = require('./db');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ✅ Expose folder uploads supaya foto bisa diakses dari mobile
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ═══════════════════════════════════════
   HELPER
═══════════════════════════════════════ */
function nowDatetime() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
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
      last_updated: u.last_updated ? u.last_updated.toString().slice(0, 19) : '',
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

    return response(res, 200, { ket: 'data berhasil di update' });
  } catch (e) {
    console.error('[UPDATE-PROFILE]', e.message);
    return response(res, 500, { message: 'Server error' });
  }
});

/* ═══════════════════════════════════════
   ✅ CAD ROUTES — mount di sini
═══════════════════════════════════════ */
const cadRoute = require('./cad.route');
app.use('/api/cad', cadRoute);

/* ═══════════════════════════════════════
   HEALTH CHECK
═══════════════════════════════════════ */
app.get('/health', (_, res) => res.json({ status: 'ok', time: nowDatetime() }));

app.listen(PORT, () => {
  console.log(`🚀 GPS Backend running at http://localhost:${PORT}`);
  console.log(`📋 Endpoints:`);
  console.log(`   POST /api/login`);
  console.log(`   GET  /api/profile?userId=1`);
  console.log(`   POST /api/update-location`);
  console.log(`   POST /api/update-profile`);
  console.log(`   GET  /api/cad/my-task?userId=1`);
  console.log(`   POST /api/cad/terima-task`);
  console.log(`   POST /api/cad/menuju`);
  console.log(`   POST /api/cad/tiba`);
  console.log(`   POST /api/cad/selesai`);
  console.log(`   POST /api/cad/upload-photo`);
  console.log(`   GET  /health`);
});