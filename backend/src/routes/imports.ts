import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { inspectUploadedFile, startImportBatch, updateBatchMapping, getBatchPreview, approveBatch, rejectBatch, getBatchMappingState } from '../services/importPipeline';
import { pool } from '../db/pool';

export const importsRouter = Router();

const STORAGE_DIR = process.env.STORAGE_DIR || './storage/uploads';
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, STORAGE_DIR),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}_${randomUUID()}${safeExt}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const okExt = ['.xlsx', '.xls'].includes(path.extname(file.originalname).toLowerCase());
    const okMime = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ].includes(file.mimetype);
    if (!okExt) return cb(new Error('يُسمح فقط بملفات Excel (.xlsx / .xls)'));
    cb(null, okExt || okMime);
  },
});

// Step 1: Upload -> Parse -> Header Detection -> Sheet Classification (inspection only, no DB writes to core tables).
importsRouter.post('/upload', requireAuth, upload.single('file'), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });
  try {
    const inspection = await inspectUploadedFile(req.file.path);
    res.json({
      storagePath: req.file.path,
      originalFileName: req.file.originalname,
      sheets: inspection.sheets,
    });
  } catch (err: any) {
    fs.unlink(req.file.path, () => {});
    res.status(422).json({ error: 'تعذّرت قراءة الملف — تأكد أنه ملف Excel صالح', detail: String(err.message || err) });
  }
});

const startBatchSchema = z.object({
  agreementId: z.string().uuid(),
  logicalSourceKey: z.string().min(2).regex(/^[a-z0-9_]+$/, 'استخدم أحرفًا إنجليزية صغيرة وأرقامًا و "_" فقط'),
  sheetName: z.string().min(1),
  headerRowNumber: z.number().int().min(1),
  headerColumns: z.array(z.string()),
  columnCount: z.number().int().min(1),
  storagePath: z.string(),
  originalFileName: z.string(),
  sheetClassification: z.enum(['data', 'reference', 'cover_or_legal', 'empty']),
  headerWasManuallyOverridden: z.boolean().optional(),
});

// Step 2: Field Mapping proposal + Step 3: Staging (streamed insert into staging_products).
importsRouter.post('/batches', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = startBatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const d = parsed.data;

  const result = await startImportBatch({
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
    uploadedBy: req.user!.id,
  });

  res.status(201).json(result);
});

const mappingSchema = z.object({
  mapping: z.array(
    z.object({
      columnIndex: z.number().int().min(0),
      sourceColumnName: z.string(),
      mappedConcept: z.string(),
      confidence: z.enum(['auto_high', 'auto_low', 'manual']),
      isSearchable: z.boolean(),
      isFilterable: z.boolean(),
      visibility: z.enum(['visible_user', 'admin_only', 'hidden']),
    }),
  ),
});

// Admin confirms/edits the proposed mapping ("ربط الأعمدة").
importsRouter.put('/batches/:id/mapping', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = mappingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const result = await updateBatchMapping(req.params.id, parsed.data.mapping as any, req.user!.id);
  res.json(result);
});

// Step: Preview — paginated, DB-backed (never a full in-memory dump).
importsRouter.get('/batches/:id/preview', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 200);
  const offset = Number(req.query.offset) || 0;
  const preview = await getBatchPreview(req.params.id, limit, offset);
  res.json(preview);
});

importsRouter.get('/batches/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
  const issues = await pool.query(`SELECT * FROM import_issues WHERE batch_id = $1 ORDER BY row_number LIMIT 200`, [req.params.id]);
  let mappingState: any = {};
  if (rows[0].status !== 'rejected' && rows[0].status !== 'committed') {
    try {
      mappingState = await getBatchMappingState(req.params.id);
    } catch {
      /* staging rows may already be gone for a terminal batch */
    }
  }
  res.json({ ...rows[0], issues: issues.rows, ...mappingState });
});

// Step: Approval / Commit transaction.
importsRouter.post('/batches/:id/approve', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const visibleToUsers = req.body?.visibleToUsers !== false;
    const result = await approveBatch(req.params.id, { approvedBy: req.user!.id, visibleToUsers });
    res.json(result);
  } catch (err: any) {
    res.status(409).json({ error: String(err.message || err) });
  }
});

importsRouter.post('/batches/:id/reject', requireAuth, async (req: AuthedRequest, res) => {
  await rejectBatch(req.params.id, req.user!.id);
  res.json({ ok: true });
});
