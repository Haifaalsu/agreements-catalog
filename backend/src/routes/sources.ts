import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth, AuthedRequest } from '../middleware/auth';

export const sourcesRouter = Router();

// Admin: full history (active + replaced + archived) for one agreement.
sourcesRouter.get('/', requireAuth, async (req, res) => {
  const agreementId = req.query.agreementId as string | undefined;
  const { rows } = await pool.query(
    `SELECT s.*, (SELECT count(*) FROM products p WHERE p.source_id = s.id) AS actual_row_count,
            u.full_name AS imported_by_name
     FROM sources s LEFT JOIN users u ON u.id = s.imported_by
     WHERE ($1::uuid IS NULL OR s.agreement_id = $1)
     ORDER BY s.imported_at DESC`,
    [agreementId ?? null],
  );
  res.json(rows);
});

// Toggle visibility / status for an already-committed source (e.g. archive
// Microsoft "Old Education" after the fact, or later un-archive it).
sourcesRouter.patch('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const { isVisibleToUsers, status } = req.body as { isVisibleToUsers?: boolean; status?: 'active' | 'archived' };
  const { rows } = await pool.query(
    `UPDATE sources SET is_visible_to_users = COALESCE($2, is_visible_to_users), status = COALESCE($3, status)
     WHERE id = $1 RETURNING *`,
    [req.params.id, isVisibleToUsers ?? null, status ?? null],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'غير موجود' });

  await pool.query(
    `INSERT INTO import_logs (agreement_id, source_id, action, performed_by, details) VALUES ($1,$2,'visibility_change',$3,$4)`,
    [rows[0].agreement_id, rows[0].id, req.user!.id, JSON.stringify({ isVisibleToUsers, status })],
  );
  res.json(rows[0]);
});

sourcesRouter.get('/logs', requireAuth, async (req, res) => {
  const agreementId = req.query.agreementId as string | undefined;
  const { rows } = await pool.query(
    `SELECT l.*, u.full_name AS performed_by_name, a.name_ar AS agreement_name
     FROM import_logs l LEFT JOIN users u ON u.id = l.performed_by LEFT JOIN agreements a ON a.id = l.agreement_id
     WHERE ($1::uuid IS NULL OR l.agreement_id = $1)
     ORDER BY l.performed_at DESC LIMIT 200`,
    [agreementId ?? null],
  );
  res.json(rows);
});
