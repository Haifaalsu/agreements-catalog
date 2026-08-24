import { pool, withTransaction } from '../db/pool';
import { listSheetsWithSample, streamSheetDataRows, SheetSummary } from './excelParser';
import { detectHeaderRow } from './headerDetector';
import { classifySheet } from './sheetClassifier';
import { proposeMappingForHeaders, overlayPersistedMappings, persistMapping, annotateConflicts, AnnotatedMappingProposal, MappingConflict } from './fieldMapper';
import { projectRow } from './rowProjector';
import { ColumnMappingProposal, DetectedHeader, SheetClassification } from '../types';

export interface UploadInspection {
  storagePath: string;
  sheets: {
    sheetName: string;
    rowCount: number;
    columnCount: number;
    header: DetectedHeader;
    classification: SheetClassification;
  }[];
}

/** Step: Upload -> Parse -> Header Detection -> Sheet Classification (no DB writes yet, purely inspection). */
export async function inspectUploadedFile(storagePath: string): Promise<UploadInspection> {
  const summaries = await listSheetsWithSample(storagePath, 20);
  const sheets = summaries.map((s: SheetSummary) => {
    const header = detectHeaderRow(s.sampleRows);
    const classification = classifySheet(s, header);
    return { sheetName: s.sheetName, rowCount: s.rowCount, columnCount: s.columnCount, header, classification };
  });
  return { storagePath, sheets };
}

export interface StartBatchParams {
  agreementId: string;
  logicalSourceKey: string;
  sheetName: string;
  headerRowNumber: number; // confirmed (auto or manual override)
  headerColumns: string[];
  columnCount: number;
  originalFileName: string;
  storagePath: string;
  sheetClassification: SheetClassification;
  headerConfidence: 'high' | 'low' | 'manual';
  uploadedBy: string | null;
}

export interface StartBatchResult {
  batchId: string;
  mapping: AnnotatedMappingProposal[];
  conflicts: MappingConflict[];
  sampleValues: string[][]; // sampleValues[columnIndex] = up to 5 sample raw values
  totalRowsStaged: number;
  errorCount: number;
  warningCount: number;
}

/** Step: Field Mapping (proposal + persisted overlay) -> Staging (streamed, chunked, never fully in memory). */
export async function startImportBatch(params: StartBatchParams): Promise<StartBatchResult> {
  const batchRes = await pool.query(
    `INSERT INTO import_batches (agreement_id, logical_source_key, original_file_name, storage_path, sheet_name,
        header_row, header_confidence, sheet_classification, status, uploaded_by, header_columns)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'parsing',$9,$10) RETURNING id`,
    [
      params.agreementId, params.logicalSourceKey, params.originalFileName, params.storagePath, params.sheetName,
      params.headerRowNumber, params.headerConfidence, params.sheetClassification, params.uploadedBy, params.headerColumns,
    ],
  );
  const batchId = batchRes.rows[0].id as string;

  let mapping = proposeMappingForHeaders(params.headerColumns);
  mapping = await overlayPersistedMappings(params.agreementId, params.logicalSourceKey, mapping);

  let errorCount = 0;
  const warnings: { rowNumber: number | null; code: string; message: string }[] = [];
  const sampleValues: string[][] = params.headerColumns.map(() => []);

  const { totalRows } = await streamSheetDataRows(
    params.storagePath,
    params.sheetName,
    params.headerRowNumber,
    params.columnCount,
    async (rows) => {
      const values: any[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const row of rows) {
        if (row.cells.length !== params.columnCount) {
          warnings.push({ rowNumber: row.rowNumber, code: 'column_count_mismatch', message: `عدد الخلايا (${row.cells.length}) لا يطابق عدد أعمدة الرأس (${params.columnCount})` });
        }
        row.cells.forEach((c, idx) => {
          if (sampleValues[idx] && sampleValues[idx].length < 5 && c !== null && String(c).trim() !== '') {
            const s = String(c);
            if (!sampleValues[idx].includes(s)) sampleValues[idx].push(s);
          }
        });
        const { rawData, mapped, attributes } = projectRow(params.headerColumns, mapping, row.cells);
        tuples.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        values.push(
          batchId, row.rowNumber, JSON.stringify(rawData),
          mapped.product_id, mapped.name_ar, mapped.name_en, mapped.description_ar, mapped.description_en,
          mapped.supplier_id, mapped.supplier_name, mapped.category_l1, mapped.category_l2, mapped.category_l3,
          mapped.manufacturer, mapped.model, mapped.country_of_origin, mapped.unit,
          JSON.stringify(attributes),
        );
      }
      if (tuples.length > 0) {
        await pool.query(
          `INSERT INTO staging_products
            (batch_id, row_number, raw_data, mapped_product_id, mapped_name_ar, mapped_name_en,
             mapped_description_ar, mapped_description_en, mapped_supplier_id, mapped_supplier_name,
             mapped_category_l1, mapped_category_l2, mapped_category_l3, mapped_manufacturer, mapped_model,
             mapped_country_of_origin, mapped_unit, mapped_attributes)
           VALUES ${tuples.join(',')}`,
          values,
        );
      }
    },
    500,
  );

  if (warnings.length > 0) {
    const issueValues: any[] = [];
    const issueTuples: string[] = [];
    let p = 1;
    for (const w of warnings.slice(0, 5000)) {
      issueTuples.push(`($${p++},$${p++},'warning',$${p++},$${p++})`);
      issueValues.push(batchId, w.rowNumber, w.code, w.message);
    }
    await pool.query(`INSERT INTO import_issues (batch_id, row_number, severity, code, message) VALUES ${issueTuples.join(',')}`, issueValues);
  }

  await pool.query(
    `UPDATE import_batches SET status = 'ready_for_review', total_rows_parsed = $2, error_count = $3, warning_count = $4 WHERE id = $1`,
    [batchId, totalRows, errorCount, warnings.length],
  );

  const { annotated, conflicts } = annotateConflicts(mapping);
  return { batchId, mapping: annotated, conflicts, sampleValues, totalRowsStaged: totalRows, errorCount, warningCount: warnings.length };
}

/** Admin corrects mapping on the "ربط الأعمدة" screen -> re-project all already-staged rows from their stored raw_data. */
export async function updateBatchMapping(
  batchId: string,
  mapping: ColumnMappingProposal[],
  confirmedBy: string | null,
): Promise<{ updatedRows: number; conflicts: MappingConflict[] }> {
  const batch = await pool.query(`SELECT agreement_id, logical_source_key, header_columns FROM import_batches WHERE id = $1`, [batchId]);
  if (batch.rows.length === 0) throw new Error('Import batch not found');
  const { agreement_id, logical_source_key, header_columns } = batch.rows[0];

  await persistMapping(agreement_id, logical_source_key, mapping, confirmedBy);

  // IMPORTANT: headers must come from the batch's stored, ORDERED column
  // list — never from Object.keys(raw_data). JSONB does not guarantee key
  // order is preserved, so reconstructing column position from it would
  // silently misalign every mapped_* value (see migration 004).
  const headers: string[] = header_columns;
  // raw_data keys are suffixed on duplicates by projectRow (e.g. "الفئة (2)"),
  // so rebuild the same de-duplicated key list here to read values back out correctly.
  const seen = new Map<string, number>();
  const rawKeys = headers.map((h) => {
    const key = (h || '').trim() || h;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence === 1 ? key : `${key} (${occurrence})`;
  });

  const { rows } = await pool.query(`SELECT id, raw_data FROM staging_products WHERE batch_id = $1`, [batchId]);

  // Batched multi-row UPDATE ... FROM (VALUES ...) instead of one round trip
  // per row — at 74k+ rows (Digital Circuits) a per-row UPDATE loop measured
  // ~50s; chunked bulk updates bring this down to a couple of seconds.
  const CHUNK = 1000;
  let updated = 0;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values: any[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const r of chunk) {
      const cells = rawKeys.map((k) => (r.raw_data as any)[k] ?? null);
      const { mapped, attributes } = projectRow(headers, mapping, cells);
      tuples.push(
        `($${p++}::uuid,$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb)`,
      );
      values.push(
        r.id, mapped.product_id, mapped.name_ar, mapped.name_en, mapped.description_ar, mapped.description_en,
        mapped.supplier_id, mapped.supplier_name, mapped.category_l1, mapped.category_l2, mapped.category_l3,
        mapped.manufacturer, mapped.model, mapped.country_of_origin, mapped.unit, JSON.stringify(attributes),
      );
    }
    await pool.query(
      `UPDATE staging_products AS sp SET
         mapped_product_id = v.product_id, mapped_name_ar = v.name_ar, mapped_name_en = v.name_en,
         mapped_description_ar = v.description_ar, mapped_description_en = v.description_en,
         mapped_supplier_id = v.supplier_id, mapped_supplier_name = v.supplier_name,
         mapped_category_l1 = v.category_l1, mapped_category_l2 = v.category_l2, mapped_category_l3 = v.category_l3,
         mapped_manufacturer = v.manufacturer, mapped_model = v.model, mapped_country_of_origin = v.country_of_origin,
         mapped_unit = v.unit, mapped_attributes = v.attributes
       FROM (VALUES ${tuples.join(',')}) AS v(id, product_id, name_ar, name_en, description_ar, description_en,
         supplier_id, supplier_name, category_l1, category_l2, category_l3, manufacturer, model, country_of_origin, unit, attributes)
       WHERE sp.id = v.id`,
      values,
    );
    updated += chunk.length;
  }
  const { conflicts } = annotateConflicts(mapping);
  return { updatedRows: updated, conflicts };
}

/** Recomputes conflicts for a batch's CURRENT mapping (persisted, confirmed-or-proposed) — used by GET /batches/:id so a reloaded Admin screen still shows warnings. */
export async function getBatchMappingState(batchId: string): Promise<{ mapping: AnnotatedMappingProposal[]; conflicts: MappingConflict[]; sampleValues: string[][] }> {
  const batch = await pool.query(`SELECT agreement_id, logical_source_key, header_columns FROM import_batches WHERE id = $1`, [batchId]);
  if (batch.rows.length === 0) throw new Error('Import batch not found');
  const { agreement_id, logical_source_key, header_columns } = batch.rows[0];

  let mapping = proposeMappingForHeaders(header_columns);
  mapping = await overlayPersistedMappings(agreement_id, logical_source_key, mapping);
  const { annotated, conflicts } = annotateConflicts(mapping);

  const seen = new Map<string, number>();
  const rawKeys: string[] = header_columns.map((h: string) => {
    const key = (h || '').trim() || h;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence === 1 ? key : `${key} (${occurrence})`;
  });
  const { rows } = await pool.query(`SELECT raw_data FROM staging_products WHERE batch_id = $1 LIMIT 30`, [batchId]);
  const sampleValues: string[][] = header_columns.map(() => []);
  for (const r of rows) {
    rawKeys.forEach((k, idx) => {
      const v = (r.raw_data as any)[k];
      if (v !== null && v !== undefined && String(v).trim() !== '' && sampleValues[idx].length < 5) {
        const s = String(v);
        if (!sampleValues[idx].includes(s)) sampleValues[idx].push(s);
      }
    });
  }

  return { mapping: annotated, conflicts, sampleValues };
}

export interface PreviewResult {
  rows: any[];
  total: number;
  distinctSuppliers: number | null;
  distinctCategories: number | null;
}

/** Preview reads paginated staging rows from the DB — never the in-memory parse result. */
export async function getBatchPreview(batchId: string, limit = 25, offset = 0): Promise<PreviewResult> {
  const [rowsRes, countRes, statsRes] = await Promise.all([
    pool.query(`SELECT * FROM staging_products WHERE batch_id = $1 ORDER BY row_number LIMIT $2 OFFSET $3`, [batchId, limit, offset]),
    pool.query(`SELECT count(*)::int AS c FROM staging_products WHERE batch_id = $1`, [batchId]),
    pool.query(
      `SELECT count(DISTINCT mapped_supplier_name) FILTER (WHERE mapped_supplier_name IS NOT NULL) AS suppliers,
              count(DISTINCT mapped_category_l1) FILTER (WHERE mapped_category_l1 IS NOT NULL) AS categories
       FROM staging_products WHERE batch_id = $1`,
      [batchId],
    ),
  ]);
  return {
    rows: rowsRes.rows,
    total: countRes.rows[0].c,
    distinctSuppliers: statsRes.rows[0].suppliers === null ? null : Number(statsRes.rows[0].suppliers),
    distinctCategories: statsRes.rows[0].categories === null ? null : Number(statsRes.rows[0].categories),
  };
}

export interface ApproveOptions {
  visibleToUsers?: boolean; // false for archive-on-arrival sources (e.g. "Old Education")
  approvedBy: string | null;
}

/** Approval / Replacement transaction — the only place `products` is ever mutated by an import. */
export async function approveBatch(batchId: string, opts: ApproveOptions): Promise<{ sourceId: string; rowCount: number }> {
  return withTransaction(async (client) => {
    const batchRes = await client.query(
      `SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`,
      [batchId],
    );
    if (batchRes.rows.length === 0) throw new Error('Import batch not found');
    const batch = batchRes.rows[0];
    if (batch.status !== 'ready_for_review' && batch.status !== 'mapping_pending') {
      throw new Error(`لا يمكن اعتماد Batch بحالة ${batch.status}`);
    }

    // Demote the current active source for this exact logical key FIRST
    // (amendment 1 — keyed on agreement_id + logical_source_key, never the
    // literal sheet name). This must happen before inserting the new 'active'
    // row: sources_active_logical_key_uq only allows one active row per key,
    // so inserting the replacement first would violate it.
    const oldActiveRes = await client.query(
      `UPDATE sources SET status = 'replaced', replaced_at = now()
       WHERE agreement_id = $1 AND logical_source_key = $2 AND status = 'active'
       RETURNING id`,
      [batch.agreement_id, batch.logical_source_key],
    );

    const sourceRes = await client.query(
      `INSERT INTO sources (agreement_id, logical_source_key, original_file_name, sheet_name, header_row,
          storage_path, status, is_visible_to_users, row_count, imported_by, header_columns)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10) RETURNING id`,
      [batch.agreement_id, batch.logical_source_key, batch.original_file_name, batch.sheet_name, batch.header_row,
        batch.storage_path, opts.visibleToUsers ?? true, batch.total_rows_parsed, opts.approvedBy, batch.header_columns],
    );
    const newSourceId = sourceRes.rows[0].id as string;

    if (oldActiveRes.rows.length > 0) {
      await client.query(
        `UPDATE sources SET superseded_by = $1 WHERE id = ANY($2::uuid[])`,
        [newSourceId, oldActiveRes.rows.map((r) => r.id)],
      );
    }

    // Move staged rows -> products (bulk, single statement, still inside the transaction).
    const insertRes = await client.query(
      `INSERT INTO products (source_id, agreement_id, row_number, raw_data, mapped_product_id, mapped_name_ar,
          mapped_name_en, mapped_description_ar, mapped_description_en, mapped_supplier_id, mapped_supplier_name,
          mapped_category_l1, mapped_category_l2, mapped_category_l3, mapped_manufacturer, mapped_model,
          mapped_country_of_origin, mapped_unit, mapped_attributes)
       SELECT $1, $2, row_number, raw_data, mapped_product_id, mapped_name_ar, mapped_name_en, mapped_description_ar,
          mapped_description_en, mapped_supplier_id, mapped_supplier_name, mapped_category_l1, mapped_category_l2,
          mapped_category_l3, mapped_manufacturer, mapped_model, mapped_country_of_origin, mapped_unit, mapped_attributes
       FROM staging_products WHERE batch_id = $3`,
      [newSourceId, batch.agreement_id, batchId],
    );

    await client.query(
      `UPDATE import_batches SET status = 'committed', committed_source_id = $2, committed_at = now() WHERE id = $1`,
      [batchId, newSourceId],
    );

    await client.query(`DELETE FROM staging_products WHERE batch_id = $1`, [batchId]);

    await client.query(
      `INSERT INTO import_logs (agreement_id, source_id, batch_id, action, performed_by, row_count, error_count, warning_count, details)
       VALUES ($1,$2,$3,'approve',$4,$5,$6,$7,$8)`,
      [batch.agreement_id, newSourceId, batchId, opts.approvedBy, insertRes.rowCount, batch.error_count, batch.warning_count,
        JSON.stringify({ sheet_name: batch.sheet_name, logical_source_key: batch.logical_source_key })],
    );

    return { sourceId: newSourceId, rowCount: insertRes.rowCount ?? 0 };
  });
}

export async function rejectBatch(batchId: string, rejectedBy: string | null): Promise<void> {
  await withTransaction(async (client) => {
    const batchRes = await client.query(`SELECT agreement_id FROM import_batches WHERE id = $1`, [batchId]);
    if (batchRes.rows.length === 0) throw new Error('Import batch not found');
    await client.query(`DELETE FROM staging_products WHERE batch_id = $1`, [batchId]);
    await client.query(`UPDATE import_batches SET status = 'rejected', rejected_at = now() WHERE id = $1`, [batchId]);
    await client.query(
      `INSERT INTO import_logs (agreement_id, batch_id, action, performed_by) VALUES ($1,$2,'reject',$3)`,
      [batchRes.rows[0].agreement_id, batchId, rejectedBy],
    );
  });
}
