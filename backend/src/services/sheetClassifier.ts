import { SheetClassification } from '../types';
import { SheetSummary } from './excelParser';
import { DetectedHeader } from '../types';

/**
 * Proposes a classification for a sheet so Admin isn't asked to eyeball
 * every single sheet during import. Always overridable — see the Preview
 * step, where Admin confirms or corrects this before Approval.
 */
export function classifySheet(summary: SheetSummary, header: DetectedHeader): SheetClassification {
  const dataRowCount = Math.max(0, summary.rowCount - header.headerRowIndex);

  if (summary.rowCount === 0) return 'empty';

  // Cover / legal notice: almost no rows have more than 1-2 filled cells,
  // but at least one cell is a very long block of text (legal disclaimer,
  // title page) — matches "الغلاف" / "الاشعار" observed in real files.
  const denseSampleRows = summary.sampleRows.filter((r) => r.filter((c) => c !== null && String(c).trim() !== '').length >= 3);
  const hasVeryLongText = summary.sampleRows.some((r) => r.some((c) => typeof c === 'string' && c.length > 400));
  if (denseSampleRows.length === 0 && hasVeryLongText) return 'cover_or_legal';
  if (denseSampleRows.length === 0 && summary.rowCount <= 5) return 'empty';

  // Reference / lookup table: small, narrow, self-contained code/name pairs
  // (e.g. Order Unit, Product Category, Suppliers list) rather than a full
  // product/service catalog.
  if (dataRowCount > 0 && dataRowCount <= 60 && summary.columnCount <= 6) {
    return 'reference';
  }

  return 'data';
}
