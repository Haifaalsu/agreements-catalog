"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRow = projectRow;
function asText(v) {
    if (v === null || v === undefined)
        return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}
/**
 * Projects one raw Excel row into: (a) raw_data JSONB keyed by the ORIGINAL
 * column headers (kept verbatim — Source of Truth, amendment "Raw Row =
 * Source of Truth"), and (b) the mapped_* convenience fields, derived purely
 * from the confirmed field mapping and safe to drop/rebuild at any time.
 *
 * Duplicate header names (amendment 2) are disambiguated in raw_data by
 * suffixing repeats with their 1-based occurrence number, e.g.
 * "الفئة" and "الفئة (2)", so no value is silently overwritten.
 */
function projectRow(headers, mapping, cells) {
    const rawData = {};
    const seenHeaderCount = new Map();
    const mapped = {
        product_id: null, name_ar: null, name_en: null, description_ar: null, description_en: null,
        supplier_id: null, supplier_name: null, category_l1: null, category_l2: null, category_l3: null,
        manufacturer: null, model: null, country_of_origin: null, unit: null, contract_number: null, grouping_id: null,
    };
    const attributes = {};
    headers.forEach((header, idx) => {
        const key = (header || `عمود ${idx + 1}`).trim() || `عمود ${idx + 1}`;
        const occurrence = (seenHeaderCount.get(key) ?? 0) + 1;
        seenHeaderCount.set(key, occurrence);
        const rawKey = occurrence === 1 ? key : `${key} (${occurrence})`;
        rawData[rawKey] = cells[idx] ?? null;
        const colMapping = mapping.find((m) => m.columnIndex === idx);
        if (!colMapping)
            return;
        const concept = colMapping.mappedConcept;
        const value = asText(cells[idx] ?? null);
        if (value === null)
            return;
        if (concept.startsWith('attribute:')) {
            attributes[concept.slice('attribute:'.length)] = value;
            return;
        }
        if (concept in mapped) {
            mapped[concept] = value;
        }
    });
    return { rawData, mapped, attributes };
}
//# sourceMappingURL=rowProjector.js.map