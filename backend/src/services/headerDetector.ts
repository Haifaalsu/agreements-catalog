import { DetectedHeader } from '../types';

/**
 * Scores each of the first `sampleRows` rows as a candidate header row and
 * returns the best guess with a confidence level. Never assumed to be row 1
 * — real files in this project have 0 to 4 title/blank/note rows before the
 * actual header (confirmed during Phase 1 inspection).
 *
 * Heuristic (no ML — deliberately simple & auditable):
 *   - candidate must have a healthy number of filled, mostly-text cells
 *   - the row(s) immediately below it must look like data: comparable or
 *     higher fill ratio, and NOT mostly identical to the header itself
 *   - a lone row with 1-2 filled cells where one is a very long sentence
 *     (title / note / legal text) is penalized, not rewarded
 */
export function detectHeaderRow(sampleRows: (string | number | boolean | null)[][]): DetectedHeader {
  if (sampleRows.length === 0) {
    return { headerRowIndex: 1, confidence: 'low', columns: [] };
  }

  const columnCount = Math.max(...sampleRows.map((r) => r.length));
  const scores: { rowIndex: number; score: number }[] = [];

  const maxCandidate = Math.min(sampleRows.length - 1, 14); // look within first 15 rows, need >=1 row after it

  for (let i = 0; i <= maxCandidate; i++) {
    const row = sampleRows[i];
    const filled = row.filter((c) => c !== null && String(c).trim() !== '').length;
    if (filled < 2) {
      scores.push({ rowIndex: i, score: -100 });
      continue;
    }

    const stringCells = row.filter((c) => typeof c === 'string' && c.trim() !== '');
    const stringRatio = filled > 0 ? stringCells.length / filled : 0;

    const longTextCells = stringCells.filter((c) => String(c).length > 120).length;
    const isLikelyTitleOrNote = filled <= 3 && longTextCells >= 1;

    const nextRow = sampleRows[i + 1];
    const nextFilled = nextRow ? nextRow.filter((c) => c !== null && String(c).trim() !== '').length : 0;
    const nextLooksLikeData = nextFilled >= Math.max(2, filled * 0.5);

    // A second lookahead row further reduces false positives from a
    // one-off dense row that isn't actually a header (rare but possible).
    const nextNextRow = sampleRows[i + 2];
    const nextNextFilled = nextNextRow ? nextNextRow.filter((c) => c !== null && String(c).trim() !== '').length : 0;

    let score = 0;
    score += filled * 2;
    score += (filled / Math.max(columnCount, 1)) * 10; // reward wide coverage
    if (stringRatio > 0.6) score += 6;
    if (nextLooksLikeData) score += 8;
    if (nextNextFilled >= Math.max(2, filled * 0.4)) score += 4;
    if (isLikelyTitleOrNote) score -= 15;
    // Header rows rarely repeat the exact same text as the row below them.
    if (nextRow && JSON.stringify(row) === JSON.stringify(nextRow)) score -= 20;

    scores.push({ rowIndex: i, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const second = scores[1];

  const confidence: 'high' | 'low' = best && best.score >= 15 && (!second || best.score - second.score >= 6) ? 'high' : 'low';

  const headerRowIndex = (best?.rowIndex ?? 0) + 1; // convert to 1-based Excel row number
  const columns = (sampleRows[headerRowIndex - 1] ?? []).map((c) => (c === null ? '' : String(c).trim()));

  return { headerRowIndex, confidence, columns };
}
