import { ColumnMappingProposal } from '../types';

export interface ProjectedRow {
  rawData: Record<string, string | number | boolean | null>;
  mapped: {
    product_id: string | null;
    name_ar: string | null;
    name_en: string | null;
    description_ar: string | null;
    description_en: string | null;
    supplier_id: string | null;
    supplier_name: string | null;
    category_l1: string | null;
    category_l2: string | null;
    category_l3: string | null;
    manufacturer: string | null;
    model: string | null;
    country_of_origin: string | null;
    unit: string | null;
    contract_number: string | null;
    grouping_id: string | null;
  };
  attributes: Record<string, string>;
}

function asText(v: string | number | boolean | null): string | null {
  if (v === null || v === undefined) return null;
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
export function projectRow(headers: string[], mapping: ColumnMappingProposal[], cells: (string | number | boolean | null)[]): ProjectedRow {
  const rawData: Record<string, string | number | boolean | null> = {};
  const seenHeaderCount = new Map<string, number>();

  const mapped: ProjectedRow['mapped'] = {
    product_id: null, name_ar: null, name_en: null, description_ar: null, description_en: null,
    supplier_id: null, supplier_name: null, category_l1: null, category_l2: null, category_l3: null,
    manufacturer: null, model: null, country_of_origin: null, unit: null, contract_number: null, grouping_id: null,
  };
  const attributes: Record<string, string> = {};

  headers.forEach((header, idx) => {
    const key = (header || `عمود ${idx + 1}`).trim() || `عمود ${idx + 1}`;
    const occurrence = (seenHeaderCount.get(key) ?? 0) + 1;
    seenHeaderCount.set(key, occurrence);
    const rawKey = occurrence === 1 ? key : `${key} (${occurrence})`;
    rawData[rawKey] = cells[idx] ?? null;

    const colMapping = mapping.find((m) => m.columnIndex === idx);
    if (!colMapping) return;
    const concept = colMapping.mappedConcept;
    const value = asText(cells[idx] ?? null);
    if (value === null) return;

    if (concept.startsWith('attribute:')) {
      attributes[concept.slice('attribute:'.length)] = value;
      return;
    }
    if (concept in mapped) {
      (mapped as any)[concept] = value;
    }
  });

  return { rawData, mapped, attributes };
}
