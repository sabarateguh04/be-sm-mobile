/**
 * cad.route.js
 * Mount di server.js dengan:
 *   const cadRoute = require('./routes/cad.route');
 *   app.use('/api/cad', cadRoute);
 *
 * Butuh multer untuk upload foto:
 *   npm install multer
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

/* ═══════════════════════════════
   MULTER — simpan foto ke /uploads/cad/
═══════════════════════════════ */
const uploadDir = path.join(__dirname, '..', 'uploads', 'cad');
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
function ok(res, data)   { return res.status(200).json(data); }
function err(res, msg, code = 500) { return res.status(code).json({ message: msg }); }

/* ═══════════════════════════════
   1. GET /api/cad/my-task
   Query param: ?userId=1
   Ambil task yang di-assign ke petugas,
   status belum SELESAI/DITOLAK
═══════════════════════════════ */
router.get('/my-task', async (req, res) => {
  const userId = parseInt(req.query.userId);
  if (!userId) return err(res, 'userId wajib', 400);

  try {
    const [rows] = await pool.query(
      `SELECT
         t.id, t.title, t.address,
         t.latitude, t.longitude,
         t.priority, t.status,
         t.pelapor, t.created_at
       FROM tbl_cad_task t
       JOIN tbl_cad_assignment a ON a.task_id = t.id
       WHERE a.user_id = ?
         AND t.status NOT IN ('SELESAI','DITOLAK','CLOSED')
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

/* ═══════════════════════════════
   2. GET /api/cad/task-detail
   Query param: ?taskId=1
═══════════════════════════════ */
router.get('/task-detail', async (req, res) => {
  const taskId = parseInt(req.query.taskId);
  if (!taskId) return err(res, 'taskId wajib', 400);

  try {
    const [[task]] = await pool.query(
      `SELECT t.*, a.user_id assigned_to, a.status asgn_status
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

/* ═══════════════════════════════
   3. POST /api/cad/terima-task
   body: { taskId, userId }
   → update assignment status = DITERIMA
   → log
═══════════════════════════════ */
router.post('/terima-task', async (req, res) => {
  const { taskId, userId } = req.body;
  if (!taskId || !userId) return err(res, 'taskId & userId wajib', 400);

  const conn = await pool.getConnection();
  try {
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

/* ═══════════════════════════════
   4. POST /api/cad/menuju
   body: { taskId, userId }
   → status = MENUJU
═══════════════════════════════ */
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

/* ═══════════════════════════════
   5. POST /api/cad/tiba
   body: { taskId, userId }
   → status = TIBA
═══════════════════════════════ */
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

/* ═══════════════════════════════
   6. POST /api/cad/selesai
   body: { taskId, userId, keterangan, photos: ['url1','url2',...] }
   → status = SELESAI
   → simpan keterangan
   → simpan foto ke tbl_cad_photo
   → tracking kembali READY (handled di mobile)
═══════════════════════════════ */
router.post('/selesai', async (req, res) => {
  const { taskId, userId, keterangan, photos = [] } = req.body;
  if (!taskId || !userId) return err(res, 'taskId & userId wajib', 400);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const waktuSelesai = now();

    // Update assignment
    await conn.query(
      `UPDATE tbl_cad_assignment
       SET status = 'SELESAI', keterangan = ?, waktu_selesai = ?, updated_at = ?
       WHERE task_id = ? AND user_id = ?`,
      [keterangan, waktuSelesai, waktuSelesai, taskId, userId],
    );

    // Update task
    await conn.query(
      `UPDATE tbl_cad_task SET status = 'SELESAI', updated_at = ? WHERE id = ?`,
      [waktuSelesai, taskId],
    );

    // Log
    await conn.query(
      `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?,?,?,?)`,
      [taskId, userId, 'SELESAI', waktuSelesai],
    );

    // Foto (URL sudah dari endpoint upload-photo)
    for (const url of photos) {
      if (url) {
        await conn.query(
          `INSERT INTO tbl_cad_photo (task_id, url, created_at) VALUES (?,?,?)`,
          [taskId, url, waktuSelesai],
        );
      }
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

/* ═══════════════════════════════
   7. POST /api/cad/upload-photo
   multipart/form-data: taskId, photo (file)
   → simpan file, return URL
═══════════════════════════════ */
router.post('/upload-photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return err(res, 'File wajib diupload', 400);

  const { taskId } = req.body;
  if (!taskId) return err(res, 'taskId wajib', 400);

  // URL relatif yang bisa diakses dari mobile
  const fileUrl = `/uploads/cad/${req.file.filename}`;

  return ok(res, { url: fileUrl, filename: req.file.filename });
});

module.exports = router;