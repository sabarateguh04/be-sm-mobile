/**
 * cad.route.js — CAD endpoints untuk mobile (petugas lapangan)
 * Mount di server.js: app.use('/api/cad', require('./cad.route'))
 */

const express = require('express');
const router  = express.Router();
const pool    = require('./db');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

/* ═══════════════════════════════
   MULTER — simpan foto ke /uploads/cad/
═══════════════════════════════ */
const uploadDir = path.join(__dirname, 'uploads', 'cad');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext  = path.extname(file.originalname) || '.jpg';
    const name = `cad_${Date.now()}${ext}`;
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

/* ═══════════════════════════════
   HELPER
═══════════════════════════════ */
function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function ok(res, data)             { return res.status(200).json(data); }
function err(res, msg, code = 500) { return res.status(code).json({ message: msg }); }

/* ═══════════════════════════════════════════════════
   1. GET /api/cad/my-task?userId=1
   Ambil task yang di-assign ke petugas,
   status task belum CLOSED
═══════════════════════════════════════════════════ */
router.get('/my-task', async (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return err(res, 'userId wajib', 400);

  try {
    const [rows] = await pool.query(
      `SELECT
         t.id, t.title, t.address,
         t.latitude, t.longitude,
         t.priority, t.status,
         t.pelapor, t.created_at,
         a.status AS my_status
       FROM tbl_cad_task t
       JOIN tbl_cad_assignment a ON a.task_id = t.id
       WHERE a.user_id = ?
         AND t.status NOT IN ('CLOSED')
       ORDER BY
         FIELD(t.priority,'HIGH','MEDIUM','LOW'),
         t.created_at ASC`,
      [userId],
    );
    return ok(res, { tasks: rows });
  } catch (e) {
    console.error('[CAD my-task]', e.message);
    return err(res, 'Server error');
  }
});

/* ═══════════════════════════════════════════════════
   2. GET /api/cad/task-detail?taskId=1
═══════════════════════════════════════════════════ */
router.get('/task-detail', async (req, res) => {
  const taskId = parseInt(req.query.taskId);
  if (!taskId) return err(res, 'taskId wajib', 400);

  try {
    const [[task]] = await pool.query(
      `SELECT t.*, a.user_id AS assigned_to, a.status AS asgn_status
       FROM tbl_cad_task t
       LEFT JOIN tbl_cad_assignment a ON a.task_id = t.id
       WHERE t.id = ? LIMIT 1`,
      [taskId],
    );
    if (!task) return err(res, 'Task tidak ditemukan', 404);

    const [logs] = await pool.query(
      `SELECT status, created_at FROM tbl_cad_assignment_log
       WHERE task_id = ? ORDER BY created_at ASC`,
      [taskId],
    );

    const [photos] = await pool.query(
      `SELECT url FROM tbl_cad_photo WHERE task_id = ?`,
      [taskId],
    );

    return ok(res, { task, logs, photos });
  } catch (e) {
    console.error('[CAD task-detail]', e.message);
    return err(res, 'Server error');
  }
});

/* ═══════════════════════════════════════════════════
   3. POST /api/cad/terima-task
   Body: { taskId, userId }
   Petugas terima task — cek task belum CLOSED
═══════════════════════════════════════════════════ */
router.post('/terima-task', async (req, res) => {
  const { taskId, userId } = req.body;
  if (!taskId || !userId) return err(res, 'taskId & userId wajib', 400);

  const conn = await pool.getConnection();
  try {
    // Cek task masih bisa diterima
    const [[task]] = await conn.query(
      `SELECT id, status FROM tbl_cad_task WHERE id = ? LIMIT 1`,
      [taskId],
    );
    if (!task) return err(res, 'Task tidak ditemukan', 404);
    if (task.status === 'CLOSED') return err(res, 'Task sudah CLOSED', 400);

    await conn.beginTransaction();

    await conn.query(
      `UPDATE tbl_cad_assignment SET status = 'DITERIMA', updated_at = ? WHERE task_id = ? AND user_id = ?`,
      [now(), taskId, userId],
    );
    await conn.query(
      `UPDATE tbl_cad_task SET status = 'DITERIMA', updated_at = ? WHERE id = ?`,
      [now(), taskId],
    );
    await conn.query(
      `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?,?,?,?)`,
      [taskId, userId, 'DITERIMA', now()],
    );

    await conn.commit();
    return ok(res, { message: 'Task diterima' });
  } catch (e) {
    await conn.rollback();
    console.error('[CAD terima-task]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   4. POST /api/cad/menuju
   Body: { taskId, userId }
═══════════════════════════════════════════════════ */
router.post('/menuju', async (req, res) => {
  const { taskId, userId } = req.body;
  if (!taskId || !userId) return err(res, 'taskId & userId wajib', 400);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE tbl_cad_assignment SET status = 'MENUJU', updated_at = ? WHERE task_id = ? AND user_id = ?`,
      [now(), taskId, userId],
    );
    await conn.query(
      `UPDATE tbl_cad_task SET status = 'MENUJU', updated_at = ? WHERE id = ?`,
      [now(), taskId],
    );
    await conn.query(
      `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?,?,?,?)`,
      [taskId, userId, 'MENUJU', now()],
    );

    await conn.commit();
    return ok(res, { message: 'Status: Menuju TKP' });
  } catch (e) {
    await conn.rollback();
    console.error('[CAD menuju]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   5. POST /api/cad/tiba
   Body: { taskId, userId }
═══════════════════════════════════════════════════ */
router.post('/tiba', async (req, res) => {
  const { taskId, userId } = req.body;
  if (!taskId || !userId) return err(res, 'taskId & userId wajib', 400);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE tbl_cad_assignment SET status = 'TIBA', updated_at = ? WHERE task_id = ? AND user_id = ?`,
      [now(), taskId, userId],
    );
    await conn.query(
      `UPDATE tbl_cad_task SET status = 'TIBA', updated_at = ? WHERE id = ?`,
      [now(), taskId],
    );
    await conn.query(
      `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?,?,?,?)`,
      [taskId, userId, 'TIBA', now()],
    );

    await conn.commit();
    return ok(res, { message: 'Status: Tiba di TKP' });
  } catch (e) {
    await conn.rollback();
    console.error('[CAD tiba]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   6. POST /api/cad/selesai
   Body: { taskId, userId, keterangan, photos: ['url1','url2',...] }
═══════════════════════════════════════════════════ */
router.post('/selesai', async (req, res) => {
  const { taskId, userId, keterangan, photos = [] } = req.body;
  if (!taskId || !userId) return err(res, 'taskId & userId wajib', 400);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const waktuSelesai = now();

    // Update assignment petugas ini → SELESAI
    await conn.query(
      `UPDATE tbl_cad_assignment
       SET status = 'SELESAI', keterangan = ?, waktu_selesai = ?, updated_at = ?
       WHERE task_id = ? AND user_id = ?`,
      [keterangan, waktuSelesai, waktuSelesai, taskId, userId],
    );

    // Update status task → SELESAI (status task ikut petugas pertama yg selesai)
    // Hanya update kalau belum SELESAI/CLOSED supaya tidak overwrite
    await conn.query(
      `UPDATE tbl_cad_task SET status = 'SELESAI', updated_at = ?
       WHERE id = ? AND status NOT IN ('SELESAI','CLOSED')`,
      [waktuSelesai, taskId],
    );

    // Log
    await conn.query(
      `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?,?,?,?)`,
      [taskId, userId, 'SELESAI', waktuSelesai],
    );

    // Simpan foto bukti
    for (const url of photos) {
      if (url) {
        await conn.query(
          `INSERT INTO tbl_cad_photo (task_id, user_id, url, created_at) VALUES (?,?,?,?)`,
          [taskId, userId, url, waktuSelesai],
        );
      }
    }

    // Set has_bukti = 1 kalau ada foto — backoffice bisa tahu sudah ada bukti
    if (photos.length > 0) {
      await conn.query(
        `UPDATE tbl_cad_task SET has_bukti = 1 WHERE id = ?`,
        [taskId],
      );
    }

    await conn.commit();
    return ok(res, { message: 'Task selesai', waktu_selesai: waktuSelesai });
  } catch (e) {
    await conn.rollback();
    console.error('[CAD selesai]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   7. POST /api/cad/upload-photo
   multipart/form-data: taskId, userId (opsional), photo (file)
   → simpan file, return URL
═══════════════════════════════════════════════════ */
router.post('/upload-photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return err(res, 'File wajib diupload', 400);

  const { taskId } = req.body;
  if (!taskId) return err(res, 'taskId wajib', 400);

  const fileUrl = `/uploads/cad/${req.file.filename}`;

  return ok(res, { url: fileUrl, filename: req.file.filename });
});


/* ═══════════════════════════════════════════════════
   STATS — GET /api/cad/stats?userId=1
   Statistik CAD petugas: total, hari ini, minggu, bulan,
   rata-rata durasi penanganan
═══════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return err(res, 'userId wajib', 400);

  try {
    const [[row]] = await pool.query(`
      SELECT
        COUNT(*)                                                              AS total,
        SUM(CASE WHEN a.status = 'SELESAI'                    THEN 1 ELSE 0 END) AS total_selesai,
        SUM(CASE WHEN DATE(a.waktu_selesai) = CURDATE()       THEN 1 ELSE 0 END) AS hari_ini,
        SUM(CASE WHEN YEARWEEK(a.waktu_selesai, 1)
                      = YEARWEEK(CURDATE(), 1)                THEN 1 ELSE 0 END) AS minggu_ini,
        SUM(CASE WHEN MONTH(a.waktu_selesai) = MONTH(CURDATE())
                  AND YEAR(a.waktu_selesai) = YEAR(CURDATE()) THEN 1 ELSE 0 END) AS bulan_ini,
        ROUND(
          AVG(
            CASE WHEN a.status = 'SELESAI' AND a.waktu_selesai IS NOT NULL
            THEN TIMESTAMPDIFF(MINUTE, a.created_at, a.waktu_selesai)
            END
          )
        )                                                                     AS avg_minutes
      FROM tbl_cad_assignment a
      WHERE a.user_id = ?
    `, [userId]);

    // Format avg menjadi string "Xj Ym" atau "Ym"
    let avg_duration = '-';
    if (row.avg_minutes) {
      const h = Math.floor(row.avg_minutes / 60);
      const m = row.avg_minutes % 60;
      avg_duration = h > 0 ? `${h}j ${m}m` : `${m} menit`;
    }

    return ok(res, {
      total:        row.total         || 0,
      total_selesai:row.total_selesai || 0,
      hari_ini:     row.hari_ini      || 0,
      minggu_ini:   row.minggu_ini    || 0,
      bulan_ini:    row.bulan_ini     || 0,
      avg_duration,
    });
  } catch (e) {
    console.error('[CAD stats]', e.message);
    return err(res, 'Server error');
  }
});

module.exports = router;