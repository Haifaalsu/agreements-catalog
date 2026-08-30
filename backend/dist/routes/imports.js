"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importsRouter = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = require("crypto");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const importPipeline_1 = require("../services/importPipeline");
const pool_1 = require("../db/pool");
exports.importsRouter = (0, express_1.Router)();
const STORAGE_DIR = process.env.STORAGE_DIR || './storage/uploads';
fs_1.default.mkdirSync(STORAGE_DIR, { recursive: true });
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => cb(null, STORAGE_DIR),
        filename: (_req, file, cb) => {
            const safeExt = path_1.default.extname(file.originalname).toLowerCase();
            cb(null, `${Date.now()}_${(0, crypto_1.randomUUID)()}${safeExt}`);
        },
    }),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
    fileFilter: (_req, file, cb) => {
        const okExt = ['.xlsx', '.xls'].includes(path_1.default.extname(file.originalname).toLowerCase());
        const okMime = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
        ].includes(file.mimetype);
        if (!okExt)
            return cb(new Error('يُسمح فقط بملفات Excel (.xlsx / .xls)'));
        cb(null, okExt || okMime);
    },
});
// Step 1: Upload -> Parse -> Header Detection -> Sheet Classification (inspection only, no DB writes to core tables).
exports.importsRouter.post('/upload', auth_1.requireAuth, upload.single('file'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: 'لم يتم إرفاق ملف' });
    // multer/busboy decode multipart field values (including the filename) as
    // latin1 by default, so any non-ASCII filename (e.g. Arabic) arrives here
    // mangled — browsers actually send UTF-8 bytes. Reverse the mis-decode
    // once, right at the source, so everything downstream (DB storage, API
    // responses, the UI) sees the correct original name. Safe no-op for
    // plain-ASCII filenames.
    const originalFileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
        const inspection = await (0, importPipeline_1.inspectUploadedFile)(req.file.path);
        res.json({
            storagePath: req.file.path,
            originalFileName,
            sheets: inspection.sheets,
        });
    }
    catch (err) {
        fs_1.default.unlink(req.file.path, () => { });
        res.status(422).json({ error: 'تعذّرت قراءة الملف — تأكد أنه ملف Excel صالح', detail: String(err.message || err) });
    }
});
const startBatchSchema = zod_1.z.object({
    agreementId: zod_1.z.string().uuid(),
    logicalSourceKey: zod_1.z.string().min(2).regex(/^[a-z0-9_]+$/, 'استخدم أحرفًا إنجليزية صغيرة وأرقامًا و "_" فقط'),
    sheetName: zod_1.z.string().min(1),
    headerRowNumber: zod_1.z.number().int().min(1),
    headerColumns: zod_1.z.array(zod_1.z.string()),
    columnCount: zod_1.z.number().int().min(1),
    storagePath: zod_1.z.string(),
    originalFileName: zod_1.z.string(),
    sheetClassification: zod_1.z.enum(['data', 'reference', 'cover_or_legal', 'empty']),
    headerWasManuallyOverridden: zod_1.z.boolean().optional(),
});
// Step 2: Field Mapping proposal + Step 3: Staging (streamed insert into staging_products).
exports.importsRouter.post('/batches', auth_1.requireAuth, async (req, res) => {
    const parsed = startBatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.issues });
    const d = parsed.data;
    const result = await (0, importPipeline_1.startImportBatch)({
        agreementId: d.agreementId,
        logicalSourceKey: d.logicalSourceKey,
        sheetName: d.sheetName,
        headerRowNumber: d.headerRowNumber,
        headerColumns: d.headerColumns,
        columnCount: d.columnCount,
        originalFileName: d.originalFileName,
        storagePath: d.storagePath,
        sheetClassification: d.sheetClassification,
        headerConfidence: d.headerWasManuallyOverridden ? 'manual' : 'high',
        uploadedBy: req.user.id,
    });
    res.status(201).json(result);
});
const mappingSchema = zod_1.z.object({
    mapping: zod_1.z.array(zod_1.z.object({
        columnIndex: zod_1.z.number().int().min(0),
        sourceColumnName: zod_1.z.string(),
        mappedConcept: zod_1.z.string(),
        confidence: zod_1.z.enum(['auto_high', 'auto_low', 'manual']),
        isSearchable: zod_1.z.boolean(),
        isFilterable: zod_1.z.boolean(),
        visibility: zod_1.z.enum(['visible_user', 'admin_only', 'hidden']),
    })),
});
// Admin confirms/edits the proposed mapping ("ربط الأعمدة").
exports.importsRouter.put('/batches/:id/mapping', auth_1.requireAuth, async (req, res) => {
    const parsed = mappingSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: parsed.error.issues });
    const result = await (0, importPipeline_1.updateBatchMapping)(req.params.id, parsed.data.mapping, req.user.id);
    res.json(result);
});
// Step: Preview — paginated, DB-backed (never a full in-memory dump).
exports.importsRouter.get('/batches/:id/preview', auth_1.requireAuth, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const offset = Number(req.query.offset) || 0;
    const preview = await (0, importPipeline_1.getBatchPreview)(req.params.id, limit, offset);
    res.json(preview);
});
exports.importsRouter.get('/batches/:id', auth_1.requireAuth, async (req, res) => {
    const { rows } = await pool_1.pool.query(`SELECT * FROM import_batches WHERE id = $1`, [req.params.id]);
    if (rows.length === 0)
        return res.status(404).json({ error: 'غير موجود' });
    const issues = await pool_1.pool.query(`SELECT * FROM import_issues WHERE batch_id = $1 ORDER BY row_number LIMIT 200`, [req.params.id]);
    let mappingState = {};
    if (rows[0].status !== 'rejected' && rows[0].status !== 'committed') {
        try {
            mappingState = await (0, importPipeline_1.getBatchMappingState)(req.params.id);
        }
        catch {
            /* staging rows may already be gone for a terminal batch */
        }
    }
    res.json({ ...rows[0], issues: issues.rows, ...mappingState });
});
// Step: Approval / Commit transaction.
exports.importsRouter.post('/batches/:id/approve', auth_1.requireAuth, async (req, res) => {
    try {
        const visibleToUsers = req.body?.visibleToUsers !== false;
        const result = await (0, importPipeline_1.approveBatch)(req.params.id, { approvedBy: req.user.id, visibleToUsers });
        res.json(result);
    }
    catch (err) {
        res.status(409).json({ error: String(err.message || err) });
    }
});
exports.importsRouter.post('/batches/:id/reject', auth_1.requireAuth, async (req, res) => {
    await (0, importPipeline_1.rejectBatch)(req.params.id, req.user.id);
    res.json({ ok: true });
});
//# sourceMappingURL=imports.js.map
