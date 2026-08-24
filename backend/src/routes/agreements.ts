import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth, AuthedRequest } from '../middleware/auth';

export const agreementsRouter = Router();

// Public: list agreements (for search UI filters / navigation) — active only.
agreementsRouter.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === 'true' && (req as AuthedRequest).user;
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name_ar, a.name_en, a.description_ar, a.display_type, a.status,
            (SELECT count(*) FROM sources s WHERE s.agreement_id = a.id AND s.status='active' AND s.is_visible_to_users) AS active_source_count,
            (SELECT count(*) FROM products p JOIN sources s ON s.id = p.source_id WHERE s.agreement_id = a.id AND s.status='active' AND s.is_visible_to_users) AS product_count
     FROM agreements a
     WHERE ($1::boolean = true OR a.status = 'active')
     ORDER BY a.display_order, a.name_ar`,
    [includeInactive],
  );
  res.json(rows);
});

const createSchema = z.object({
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  nameAr: z.string().min(2),
  nameEn: z.string().optional(),
  descriptionAr: z.string().optional(),
  displayType: z.enum(['standard', 'configurator']).default('standard'),
});

agreementsRouter.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const d = parsed.data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO agreements (slug, name_ar, name_en, description_ar, display_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.slug, d.nameAr, d.nameEn ?? null, d.descriptionAr ?? null, d.displayType, req.user!.id],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'يوجد اتفاقية أخرى بنفس المعرف (slug)' });
    throw err;
  }
});

agreementsRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM agreements WHERE id = $1 OR slug = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'الاتفاقية غير موجودة' });
  res.json(rows[0]);
});
