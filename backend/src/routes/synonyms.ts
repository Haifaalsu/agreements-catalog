import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';

export const synonymsRouter = Router();

synonymsRouter.get('/', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT g.id, g.canonical_term,
           coalesce(json_agg(json_build_object('id', t.id, 'term', t.term, 'language', t.language)) FILTER (WHERE t.id IS NOT NULL), '[]') AS terms
    FROM synonym_groups g LEFT JOIN synonym_terms t ON t.synonym_group_id = g.id
    GROUP BY g.id ORDER BY g.canonical_term
  `);
  res.json(rows);
});

const createGroupSchema = z.object({ canonicalTerm: z.string().min(1) });
synonymsRouter.post('/', requireAuth, async (req, res) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { rows } = await pool.query(`INSERT INTO synonym_groups (canonical_term) VALUES ($1) RETURNING *`, [parsed.data.canonicalTerm]);
  res.status(201).json(rows[0]);
});

const addTermSchema = z.object({ term: z.string().min(1), language: z.enum(['ar', 'en']).optional() });
synonymsRouter.post('/:groupId/terms', requireAuth, async (req, res) => {
  const parsed = addTermSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  try {
    const { rows } = await pool.query(
      `INSERT INTO synonym_terms (synonym_group_id, term, language) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.groupId, parsed.data.term, parsed.data.language ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'هذا المرادف موجود مسبقًا في هذه المجموعة' });
    throw err;
  }
});

synonymsRouter.delete('/terms/:termId', requireAuth, async (req, res) => {
  await pool.query(`DELETE FROM synonym_terms WHERE id = $1`, [req.params.termId]);
  res.json({ ok: true });
});

synonymsRouter.delete('/:groupId', requireAuth, async (req, res) => {
  await pool.query(`DELETE FROM synonym_groups WHERE id = $1`, [req.params.groupId]);
  res.json({ ok: true });
});
