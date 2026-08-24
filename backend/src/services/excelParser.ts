import ExcelJS from 'exceljs';
import { ParsedRow } from '../types';

export interface SheetSummary {
  sheetName: string;
  rowCount: number; // rows below row 1 that have at least one non-empty cell (incl. header candidates)
  columnCount: number;
  sampleRows: (string | number | boolean | null)[][]; // first N raw rows, 1 = first row of the sheet
}

/** Coerce an ExcelJS cell value (which can be rich text / formula / date / hyperlink objects) into a plain scalar. */
function toPlainValue(v: ExcelJS.CellValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const anyV = v as any;
    if (Array.isArray(anyV.richText)) return anyV.richText.map((rt: any) => rt.text).join('');
    if (anyV.result !== undefined) return toPlainValue(anyV.result);
    if (anyV.text !== undefined) return toPlainValue(anyV.text);
    if (anyV.error !== undefined) return null;
    return null;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return String(v);
}

/** Sparse 1-indexed ExcelJS row.values -> dense 0-indexed plain array. */
function denseRow(values: ExcelJS.CellValue[] | { [k: number]: ExcelJS.CellValue }, columnCount: number): (string | number | boolean | null)[] {
  const out: (string | number | boolean | null)[] = new Array(columnCount).fill(null);
  const arr = values as any[];
  for (let i = 1; i <= columnCount; i++) {
    out[i - 1] = toPlainValue(arr[i]);
  }
  return out;
}

/**
 * First streaming pass: lists every worksheet, its total row count, and a
 * small sample of the first `sampleSize` rows (raw, unshifted) so the Header
 * Detector / Sheet Classifier can work without materializing the whole file.
 */
export async function listSheetsWithSample(filePath: string, sampleSize = 20): Promise<SheetSummary[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit',
    sharedStrings: 'cache',
    styles: 'ignore',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  });

  const summaries: SheetSummary[] = [];

  for await (const worksheetReader of reader as any) {
    const sheetName: string = worksheetReader.name;
    let rowCount = 0;
    let columnCount = 0;
    const sampleRows: (string | number | boolean | null)[][] = [];

    for await (const row of worksheetReader) {
      const r = row as ExcelJS.Row;
      const width = Array.isArray(r.values) ? r.values.length - 1 : 0;
      if (width > columnCount) columnCount = width;
      const hasContent = (r.values as any[]).some((v, idx) => idx > 0 && v !== null && v !== undefined && String(v).trim() !== '');
      if (hasContent) rowCount++;
      if (sampleRows.length < sampleSize) {
        sampleRows.push(denseRow(r.values as any, Math.max(width, columnCount)));
      }
    }

    // Re-pad sample rows to the sheet's final columnCount.
    const padded = sampleRows.map((row) => {
      if (row.length >= columnCount) return row;
      return [...row, ...new Array(columnCount - row.length).fill(null)];
    });

    summaries.push({ sheetName, rowCount, columnCount, sampleRows: padded });
  }

  return summaries;
}

/**
 * Second streaming pass, scoped to ONE sheet: streams data rows starting
 * right after the confirmed header row, in batches, so callers can bulk
 * insert into staging_products without ever holding the full sheet in memory.
 */
export async function streamSheetDataRows(
  filePath: string,
  targetSheetName: string,
  headerRowNumber: number,
  columnCount: number,
  onBatch: (rows: ParsedRow[]) => Promise<void>,
  batchSize = 500,
): Promise<{ totalRows: number }> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit',
    sharedStrings: 'cache',
    styles: 'ignore',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  });

  let buffer: ParsedRow[] = [];
  let totalRows = 0;

  for await (const worksheetReader of reader as any) {
    const sheetName: string = worksheetReader.name;
    if (sheetName !== targetSheetName) {
      // Must still drain this sheet's async iterator (single streaming pass
      // over the underlying zip), but we discard its rows immediately.
      for await (const _row of worksheetReader) {
        /* discard */
      }
      continue;
    }

    for await (const row of worksheetReader) {
      const r = row as ExcelJS.Row;
      if (r.number <= headerRowNumber) continue;

      const cells = denseRow(r.values as any, columnCount);
      const isEmpty = cells.every((c) => c === null || (typeof c === 'string' && c.trim() === ''));
      if (isEmpty) continue;

      buffer.push({ rowNumber: r.number, cells });
      totalRows++;

      if (buffer.length >= batchSize) {
        const toFlush = buffer;
        buffer = [];
        await onBatch(toFlush);
      }
    }
  }

  if (buffer.length > 0) {
    await onBatch(buffer);
  }

  return { totalRows };
}
