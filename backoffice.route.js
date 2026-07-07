/**
 * backoffice.route.js — CAD endpoints untuk backoffice
 * Mount di server.js: app.use('/api/backoffice', require('./backoffice.route'))
 */

const express = require('express');
const router  = express.Router();
const pool    = require('./db');
const { emitToUser } = require('./socket');
const { sendPushToMultiple } = require('./firebase_admin');

/* ═══════════════════════════════
   HELPER
═══════════════════════════════ */
function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function ok(res, data)             { return res.status(200).json(data); }
function err(res, msg, code = 500) { return res.status(code).json({ message: msg }); }

/* ═══════════════════════════════════════════════════
   1. GET /api/backoffice/list-petugas
   List petugas untuk dropdown assign
   Optional: ?status=ONLINE
═══════════════════════════════════════════════════ */
router.get('/list-petugas', async (req, res) => {
  const { status } = req.query;
  try {
    let sql = `SELECT user_id, nama, status, lat, lng, last_updated
               FROM tbl_petugas_mobile WHERE is_active = 1`;
    const params = [];
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY nama ASC`;

    const [rows] = await pool.query(sql, params);
    return ok(res, { petugas: rows });
  } catch (e) {
    console.error('[BACKOFFICE list-petugas]', e.message);
    return err(res, 'Server error');
  }
});

/* ═══════════════════════════════════════════════════
   1b. GET /api/backoffice/map-data
   Data buat halaman Pemantauan: titik laporan (task aktif)
   + siapa aja petugas yang lagi diterima/otw/di TKP suatu task
   (dipakai buat gambar jalur tracking di peta)
═══════════════════════════════════════════════════ */
router.get('/map-data', async (req, res) => {
  try {
    const [tasks] = await pool.query(
      `SELECT id, title, address, latitude, longitude, priority, status, created_at
       FROM tbl_cad_task
       WHERE status NOT IN ('CLOSED')
         AND latitude IS NOT NULL AND longitude IS NOT NULL
         AND latitude != 0 AND longitude != 0
       ORDER BY FIELD(priority,'HIGH','MEDIUM','LOW'), created_at DESC`
    );

    const [assignments] = await pool.query(
      `SELECT a.task_id, a.user_id, a.status AS asgn_status,
              p.nama, p.lat, p.lng, p.status AS petugas_status
       FROM tbl_cad_assignment a
       JOIN tbl_petugas_mobile p ON p.user_id = a.user_id
       WHERE a.status IN ('DITERIMA','MENUJU','TIBA')`
    );

    return ok(res, { tasks, assignments });
  } catch (e) {
    console.error('[BACKOFFICE map-data]', e.message);
    return err(res, 'Server error');
  }
});

/* ═══════════════════════════════════════════════════
   2. POST /api/backoffice/create-task
   Body: {
     title, address, latitude, longitude,
     priority,        → 'HIGH' | 'MEDIUM' | 'LOW'
     pelapor,
     keterangan,
     created_by,      → user_id backoffice
     assign_to: [1,2] → array user_id petugas
   }
═══════════════════════════════════════════════════ */
router.post('/create-task', async (req, res) => {
  const {
    title, address,
    latitude   = 0,
    longitude  = 0,
    priority   = 'MEDIUM',
    pelapor, keterangan,
    created_by,
    assign_to  = [],
  } = req.body;

  if (!title || !address)
    return err(res, 'title dan address wajib diisi', 400);
  if (!Array.isArray(assign_to) || assign_to.length === 0)
    return err(res, 'assign_to wajib minimal 1 petugas', 400);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO tbl_cad_task
         (title, address, latitude, longitude, priority, status, pelapor, keterangan, created_by)
       VALUES (?, ?, ?, ?, ?, 'NEW', ?, ?, ?)`,
      [title, address, latitude, longitude, priority,
       pelapor || null, keterangan || null, created_by || null],
    );
    const taskId = result.insertId;

    for (const userId of assign_to) {
      await conn.query(
        `INSERT INTO tbl_cad_assignment (task_id, user_id, status) VALUES (?, ?, 'ASSIGNED')`,
        [taskId, userId],
      );
      await conn.query(
        `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?, ?, 'ASSIGNED', ?)`,
        [taskId, userId, now()],
      );
    }

    await conn.commit();

    // ── Realtime + Push ke petugas yang di-assign ──
    try {
      const [petugasRows] = await pool.query(
        `SELECT user_id, nama, fcm_token FROM tbl_petugas_mobile WHERE user_id IN (?)`,
        [assign_to],
      );

      const tokens = petugasRows.map(p => p.fcm_token).filter(Boolean);

      for (const p of petugasRows) {
        emitToUser(p.user_id, 'new-task', {
          taskId, title, address, priority,
        });
      }

      if (tokens.length > 0) {
        await sendPushToMultiple(
          tokens,
          'Tugas Baru',
          `${title} — ${address}`,
          { type: 'new_task', taskId: String(taskId) },
        );
      }
    } catch (pushErr) {
      console.error('[PUSH create-task]', pushErr.message);
    }

    return ok(res, { message: 'Task berhasil dibuat', taskId, assigned: assign_to.length });
  } catch (e) {
    await conn.rollback();
    console.error('[BACKOFFICE create-task]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   3. POST /api/backoffice/assign-task
   Tambah petugas ke task yang sudah ada
   Body: { taskId, user_ids: [3,4] }
═══════════════════════════════════════════════════ */
router.post('/assign-task', async (req, res) => {
  const { taskId, user_ids = [] } = req.body;

  if (!taskId || !Array.isArray(user_ids) || user_ids.length === 0)
    return err(res, 'taskId dan user_ids wajib diisi', 400);

  const conn = await pool.getConnection();
  try {
    const [[task]] = await conn.query(
      `SELECT id, status FROM tbl_cad_task WHERE id = ? LIMIT 1`,
      [taskId],
    );
    if (!task)                  return err(res, 'Task tidak ditemukan', 404);
    if (task.status === 'CLOSED') return err(res, 'Task sudah CLOSED', 400);

    await conn.beginTransaction();

    let added = 0;
    for (const userId of user_ids) {
      const [[existing]] = await conn.query(
        `SELECT id FROM tbl_cad_assignment WHERE task_id = ? AND user_id = ? LIMIT 1`,
        [taskId, userId],
      );
      if (existing) continue;

      await conn.query(
        `INSERT INTO tbl_cad_assignment (task_id, user_id, status) VALUES (?, ?, 'ASSIGNED')`,
        [taskId, userId],
      );
      await conn.query(
        `INSERT INTO tbl_cad_assignment_log (task_id, user_id, status, created_at) VALUES (?, ?, 'ASSIGNED', ?)`,
        [taskId, userId, now()],
      );
      added++;
    }

    await conn.commit();

    // ── Realtime + Push ke petugas baru yang ditambahkan ──
    try {
      const [petugasRows] = await pool.query(
        `SELECT user_id, nama, fcm_token FROM tbl_petugas_mobile WHERE user_id IN (?)`,
        [user_ids],
      );
      const [[taskInfo]] = await pool.query(
        `SELECT title, address, priority FROM tbl_cad_task WHERE id = ? LIMIT 1`,
        [taskId],
      );

      const tokens = petugasRows.map(p => p.fcm_token).filter(Boolean);

      for (const p of petugasRows) {
        emitToUser(p.user_id, 'new-task', {
          taskId,
          title:    taskInfo?.title,
          address:  taskInfo?.address,
          priority: taskInfo?.priority,
        });
      }

      if (tokens.length > 0) {
        await sendPushToMultiple(
          tokens,
          'Tugas Baru',
          `${taskInfo?.title || 'CAD #' + taskId} — ${taskInfo?.address || ''}`,
          { type: 'new_task', taskId: String(taskId) },
        );
      }
    } catch (pushErr) {
      console.error('[PUSH assign-task]', pushErr.message);
    }

    return ok(res, { message: `${added} petugas berhasil di-assign`, added });
  } catch (e) {
    await conn.rollback();
    console.error('[BACKOFFICE assign-task]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   4. GET /api/backoffice/all-task
   List semua task + ringkasan progress
   Optional: ?status=NEW&priority=HIGH&page=1&limit=20
═══════════════════════════════════════════════════ */
router.get('/all-task', async (req, res) => {
  const { status, priority, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where  = 'WHERE 1=1';
    const params = [];

    if (status)   { where += ' AND t.status = ?';   params.push(status); }
    if (priority) { where += ' AND t.priority = ?'; params.push(priority); }

    const [rows] = await pool.query(
      `SELECT
         t.id, t.title, t.address, t.latitude, t.longitude,
         t.priority, t.status, t.pelapor, t.has_bukti,
         t.created_at, t.updated_at, t.closed_at,
         COUNT(DISTINCT a.user_id)                                        AS total_assigned,
         SUM(CASE WHEN a.status = 'SELESAI'  THEN 1 ELSE 0 END)          AS total_selesai,
         SUM(CASE WHEN a.status = 'DITERIMA' THEN 1 ELSE 0 END)          AS total_diterima,
         SUM(CASE WHEN a.status = 'MENUJU'   THEN 1 ELSE 0 END)          AS total_menuju,
         SUM(CASE WHEN a.status = 'TIBA'     THEN 1 ELSE 0 END)          AS total_tiba
       FROM tbl_cad_task t
       LEFT JOIN tbl_cad_assignment a ON a.task_id = t.id
       ${where}
       GROUP BY t.id
       ORDER BY FIELD(t.priority,'HIGH','MEDIUM','LOW'), t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset],
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_cad_task t ${where}`,
      params,
    );

    return ok(res, {
      tasks: rows,
      pagination: {
        page:        parseInt(page),
        limit:       parseInt(limit),
        total,
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (e) {
    console.error('[BACKOFFICE all-task]', e.message);
    return err(res, 'Server error');
  }
});

/* ═══════════════════════════════════════════════════
   5. GET /api/backoffice/task-detail?taskId=1
   Detail task + progress tiap petugas + foto bukti + log
═══════════════════════════════════════════════════ */
router.get('/task-detail', async (req, res) => {
  const taskId = parseInt(req.query.taskId);
  if (!taskId) return err(res, 'taskId wajib', 400);

  try {
    const [[task]] = await pool.query(
      `SELECT t.*, p.nama AS created_by_nama
       FROM tbl_cad_task t
       LEFT JOIN tbl_petugas_mobile p ON p.user_id = t.created_by
       WHERE t.id = ? LIMIT 1`,
      [taskId],
    );
    if (!task) return err(res, 'Task tidak ditemukan', 404);

    // Progress tiap petugas
    const [assignments] = await pool.query(
      `SELECT
         a.user_id, a.status, a.keterangan,
         a.waktu_selesai, a.created_at AS assigned_at,
         p.nama, p.url_image
       FROM tbl_cad_assignment a
       JOIN tbl_petugas_mobile p ON p.user_id = a.user_id
       WHERE a.task_id = ?
       ORDER BY a.created_at ASC`,
      [taskId],
    );

    // Log history semua petugas
    const [logs] = await pool.query(
      `SELECT l.user_id, l.status, l.created_at, p.nama
       FROM tbl_cad_assignment_log l
       JOIN tbl_petugas_mobile p ON p.user_id = l.user_id
       WHERE l.task_id = ?
       ORDER BY l.created_at ASC`,
      [taskId],
    );

    // Foto bukti per petugas
    const [photos] = await pool.query(
      `SELECT ph.url, ph.user_id, ph.created_at, p.nama
       FROM tbl_cad_photo ph
       LEFT JOIN tbl_petugas_mobile p ON p.user_id = ph.user_id
       WHERE ph.task_id = ?
       ORDER BY ph.created_at ASC`,
      [taskId],
    );

    return ok(res, { task, assignments, logs, photos });
  } catch (e) {
    console.error('[BACKOFFICE task-detail]', e.message);
    return err(res, 'Server error');
  }
});

/* ═══════════════════════════════════════════════════
   6. POST /api/backoffice/close-task
   Body: { taskId, closed_by, catatan, force }
   Syarat close: minimal 1 petugas SELESAI + has_bukti = 1
   Atau force: true untuk paksa close
═══════════════════════════════════════════════════ */
router.post('/close-task', async (req, res) => {
  const { taskId, closed_by, catatan, force = false } = req.body;
  if (!taskId || !closed_by) return err(res, 'taskId dan closed_by wajib', 400);

  const conn = await pool.getConnection();
  try {
    const [[task]] = await conn.query(
      `SELECT id, status, has_bukti FROM tbl_cad_task WHERE id = ? LIMIT 1`,
      [taskId],
    );
    if (!task)                    return err(res, 'Task tidak ditemukan', 404);
    if (task.status === 'CLOSED') return err(res, 'Task sudah CLOSED', 400);

    if (!force) {
      const [[{ selesai }]] = await conn.query(
        `SELECT COUNT(*) AS selesai FROM tbl_cad_assignment
         WHERE task_id = ? AND status = 'SELESAI'`,
        [taskId],
      );
      if (selesai === 0 || task.has_bukti === 0) {
        return err(res,
          'Belum bisa di-close: minimal 1 petugas harus SELESAI dan ada foto bukti. Gunakan force:true untuk paksa close.',
          400,
        );
      }
    }

    await conn.beginTransaction();

    const closedAt = now();
    await conn.query(
      `UPDATE tbl_cad_task
       SET status = 'CLOSED', closed_by = ?, closed_at = ?, updated_at = ?
       WHERE id = ?`,
      [closed_by, closedAt, closedAt, taskId],
    );
    await conn.query(
      `INSERT INTO tbl_cad_close_log (task_id, closed_by, catatan) VALUES (?, ?, ?)`,
      [taskId, closed_by, catatan || null],
    );

    await conn.commit();
    return ok(res, { message: 'Task berhasil di-close', taskId, closed_at: closedAt });
  } catch (e) {
    await conn.rollback();
    console.error('[BACKOFFICE close-task]', e.message);
    return err(res, 'Server error');
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   7. GET /api/backoffice/dashboard
   Statistik ringkasan + urgent task
═══════════════════════════════════════════════════ */
router.get('/dashboard', async (req, res) => {
  try {
    const [[task_stats]] = await pool.query(`
      SELECT
        COUNT(*)                                                           AS total_task,
        SUM(CASE WHEN status = 'NEW'                        THEN 1 ELSE 0 END) AS total_new,
        SUM(CASE WHEN status IN ('DITERIMA','MENUJU','TIBA') THEN 1 ELSE 0 END) AS total_on_progress,
        SUM(CASE WHEN status = 'SELESAI'                    THEN 1 ELSE 0 END) AS total_selesai,
        SUM(CASE WHEN status = 'CLOSED'                     THEN 1 ELSE 0 END) AS total_closed,
        SUM(CASE WHEN priority = 'HIGH'
                  AND status NOT IN ('SELESAI','CLOSED')    THEN 1 ELSE 0 END) AS high_priority_open
      FROM tbl_cad_task
    `);

    const [[petugas_stats]] = await pool.query(`
      SELECT
        COUNT(*)                                                    AS total_petugas,
        SUM(CASE WHEN status = 'ONLINE'   THEN 1 ELSE 0 END)       AS online,
        SUM(CASE WHEN status = 'BERTUGAS' THEN 1 ELSE 0 END)       AS bertugas,
        SUM(CASE WHEN status = 'OFFLINE'  THEN 1 ELSE 0 END)       AS offline
      FROM tbl_petugas_mobile WHERE is_active = 1
    `);

    // 5 task HIGH priority yang belum CLOSED
    const [urgent_tasks] = await pool.query(`
      SELECT id, title, address, priority, status, created_at
      FROM tbl_cad_task
      WHERE priority = 'HIGH' AND status NOT IN ('SELESAI','CLOSED')
      ORDER BY created_at DESC LIMIT 5
    `);

    return ok(res, { task_stats, petugas_stats, urgent_tasks });
  } catch (e) {
    console.error('[BACKOFFICE dashboard]', e.message);
    return err(res, 'Server error');
  }
});

module.exports = router;