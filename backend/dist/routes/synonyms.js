"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.synonymsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const pool_1 = require("../db/pool");
const auth_1 = require("../middleware/auth");
exports.synonymsRouter = (0, express_1.Router)();
exports.synonymsRouter.get('/', auth_1.requireAuth, async (_req, res) => {
    const { rows } = await pool_1.pool.query(`
    SELECT g.id, g.canonical_term,
           coalesce(json_agg(json_build_object('id', t.id, 'term', t.term, 'language', t.language)) FILTER (WHERE t.id IS NOT NULL), '[]') AS terms
    FROM synonym_groups g LEFT JOIN synonym_terms t ON t.synonym_group_id = g.id
    GROUP BY g.id ORDER BY g.canonical_term
  `);
    res.json(rows);
});
const createGroupSchema = zod_1.z.object({ canonicalTerm: zod_1.z.string().min(1) });
exports.synonymsRouter.post('/', auth_1.requireAuth, async (req, res) => {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.issues });
    const { rows } = await pool_1.pool.query(`INSERT INTO synonym_groups (canonical_term) VALUES ($1) RETURNING *`, [parsed.data.canonicalTerm]);
    res.status(201).json(rows[0]);
});
const addTermSchema = zod_1.z.object({ term: zod_1.z.string().min(1), language: zod_1.z.enum(['ar', 'en']).optional() });
exports.synonymsRouter.post('/:groupId/terms', auth_1.requireAuth, async (req, res) => {
    const parsed = addTermSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.issues });
    try {
        const { rows } = await pool_1.pool.query(`INSERT INTO synonym_terms (synonym_group_id, term, language) VALUES ($1,$2,$3) RETURNING *`, [req.params.groupId, parsed.data.term, parsed.data.language ?? null]);
        res.status(201).json(rows[0]);
    }
    catch (err) {
        if (err.code === '23505')
            return res.status(409).json({ error: 'هذا المرادف موجود مسبقًا في هذه المجموعة' });
        throw err;
    }
});
exports.synonymsRouter.delete('/terms/:termId', auth_1.requireAuth, async (req, res) => {
    await pool_1.pool.query(`DELETE FROM synonym_terms WHERE id = $1`, [req.params.termId]);
    res.json({ ok: true });
});
exports.synonymsRouter.delete('/:groupId', auth_1.requireAuth, async (req, res) => {
    await pool_1.pool.query(`DELETE FROM synonym_groups WHERE id = $1`, [req.params.groupId]);
    res.json({ ok: true });
});
//# sourceMappingURL=synonyms.js.map