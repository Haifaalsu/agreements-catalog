"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSheetsWithSample = listSheetsWithSample;
exports.streamSheetDataRows = streamSheetDataRows;
const exceljs_1 = __importDefault(require("exceljs"));
/** Coerce an ExcelJS cell value (which can be rich text / formula / date / hyperlink objects) into a plain scalar. */
function toPlainValue(v) {
    if (v === null || v === undefined)
        return null;
    if (v instanceof Date)
        return v.toISOString();
    if (typeof v === 'object') {
        const anyV = v;
        if (Array.isArray(anyV.richText))
            return anyV.richText.map((rt) => rt.text).join('');
        if (anyV.result !== undefined)
            return toPlainValue(anyV.result);
        if (anyV.text !== undefined)
            return toPlainValue(anyV.text);
        if (anyV.error !== undefined)
            return null;
        return null;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
        return v;
    return String(v);
}
/** Sparse 1-indexed ExcelJS row.values -> dense 0-indexed plain array. */
function denseRow(values, columnCount) {
    const out = new Array(columnCount).fill(null);
    const arr = values;
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
async function listSheetsWithSample(filePath, sampleSize = 20) {
    const reader = new exceljs_1.default.stream.xlsx.WorkbookReader(filePath, {
        entries: 'emit',
        sharedStrings: 'cache',
        styles: 'ignore',
        hyperlinks: 'ignore',
        worksheets: 'emit',
    });
    const summaries = [];
    for await (const worksheetReader of reader) {
        const sheetName = worksheetReader.name;
        let rowCount = 0;
        let columnCount = 0;
        const sampleRows = [];
        for await (const row of worksheetReader) {
            const r = row;
            const width = Array.isArray(r.values) ? r.values.length - 1 : 0;
            if (width > columnCount)
                columnCount = width;
            const hasContent = r.values.some((v, idx) => idx > 0 && v !== null && v !== undefined && String(v).trim() !== '');
            if (hasContent)
                rowCount++;
            if (sampleRows.length < sampleSize) {
                sampleRows.push(denseRow(r.values, Math.max(width, columnCount)));
            }
        }
        // Re-pad sample rows to the sheet's final columnCount.
        const padded = sampleRows.map((row) => {
            if (row.length >= columnCount)
                return row;
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
async function streamSheetDataRows(filePath, targetSheetName, headerRowNumber, columnCount, onBatch, batchSize = 500) {
    const reader = new exceljs_1.default.stream.xlsx.WorkbookReader(filePath, {
        entries: 'emit',
        sharedStrings: 'cache',
        styles: 'ignore',
        hyperlinks: 'ignore',
        worksheets: 'emit',
    });
    let buffer = [];
    let totalRows = 0;
    for await (const worksheetReader of reader) {
        const sheetName = worksheetReader.name;
        if (sheetName !== targetSheetName) {
            // Must still drain this sheet's async iterator (single streaming pass
            // over the underlying zip), but we discard its rows immediately.
            for await (const _row of worksheetReader) {
                /* discard */
            }
            continue;
        }
        for await (const row of worksheetReader) {
            const r = row;
            if (r.number <= headerRowNumber)
                continue;
            const cells = denseRow(r.values, columnCount);
            const isEmpty = cells.every((c) => c === null || (typeof c === 'string' && c.trim() === ''));
            if (isEmpty)
                continue;
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
//# sourceMappingURL=excelParser.js.map