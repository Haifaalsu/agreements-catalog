"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agreementsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const pool_1 = require("../db/pool");
const auth_1 = require("../middleware/auth");
exports.agreementsRouter = (0, express_1.Router)();
// Public: list agreements (for search UI filters / navigation) — active only.
exports.agreementsRouter.get('/', async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true' && req.user;
    const { rows } = await pool_1.pool.query(`SELECT a.id, a.slug, a.name_ar, a.name_en, a.description_ar, a.display_type, a.status,
            (SELECT count(*) FROM sources s WHERE s.agreement_id = a.id AND s.status='active' AND s.is_visible_to_users) AS active_source_count,
            (SELECT count(*) FROM products p JOIN sources s ON s.id = p.source_id WHERE s.agreement_id = a.id AND s.status='active' AND s.is_visible_to_users) AS product_count
     FROM agreements a
     WHERE ($1::boolean = true OR a.status = 'active')
     ORDER BY a.display_order, a.name_ar`, [includeInactive]);
    res.json(rows);
});
const createSchema = zod_1.z.object({
    slug: zod_1.z.string().min(2).regex(/^[a-z0-9-]+$/),
    nameAr: zod_1.z.string().min(2),
    nameEn: zod_1.z.string().optional(),
    descriptionAr: zod_1.z.string().optional(),
    displayType: zod_1.z.enum(['standard', 'configurator']).default('standard'),
});
exports.agreementsRouter.post('/', auth_1.requireAuth, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.issues });
    const d = parsed.data;
    try {
        const { rows } = await pool_1.pool.query(`INSERT INTO agreements (slug, name_ar, name_en, description_ar, display_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [d.slug, d.nameAr, d.nameEn ?? null, d.descriptionAr ?? null, d.displayType, req.user.id]);
        res.status(201).json(rows[0]);
    }
    catch (err) {
        if (err.code === '23505')
            return res.status(409).json({ error: 'يوجد اتفاقية أخرى بنفس المعرف (slug)' });
        throw err;
    }
});
exports.agreementsRouter.get('/:id', async (req, res) => {
    const { rows } = await pool_1.pool.query(`SELECT * FROM agreements WHERE id::text = $1 OR slug = $1`, [req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: 'الاتفاقية غير موجودة' });
    res.json(rows[0]);
});
//# sourceMappingURL=agreements.js.map
