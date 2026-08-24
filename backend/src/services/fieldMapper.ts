import { pool } from '../db/pool';
import { ColumnMappingProposal, MappedConcept, Visibility, Confidence } from '../types';
import { proposeConceptForHeader } from './conceptDictionary';

const SEARCHABLE_BY_DEFAULT: MappedConcept[] = [
  'product_id', 'name_ar', 'name_en', 'description_ar', 'description_en',
  'supplier_name', 'category_l1', 'category_l2', 'category_l3', 'manufacturer', 'model',
];
const FILTERABLE_BY_DEFAULT: MappedConcept[] = [
  'supplier_name', 'category_l1', 'category_l2', 'category_l3', 'manufacturer', 'country_of_origin', 'unit',
];

function defaultsFor(concept: MappedConcept): { searchable: boolean; filterable: boolean; visibility: Visibility } {
  if (concept === 'internal_only') return { searchable: false, filterable: false, visibility: 'admin_only' };
  if (concept === 'unmapped') return { searchable: false, filterable: false, visibility: 'visible_user' };
  return {
    searchable: SEARCHABLE_BY_DEFAULT.includes(concept),
    filterable: FILTERABLE_BY_DEFAULT.includes(concept),
    visibility: 'visible_user',
  };
}

/**
 * AMENDMENT 2: propose a mapping per physical column (index-based), and
 * explicitly detect duplicate header text within the same sheet. Duplicate
 * headers are NEVER auto-mapped with confidence — they always come back as
 * `auto_low` (or lower) so Admin must disambiguate them individually on the
 * "ربط الأعمدة" screen, since the same literal name can carry different
 * meaning per column position (confirmed in real files, e.g. "فئة الخدمات
 * المستوى الأول" appearing twice with different content).
 */
export function proposeMappingForHeaders(headers: string[]): ColumnMappingProposal[] {
  const nameCounts = new Map<string, number>();
  for (const h of headers) {
    const key = (h || '').trim();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return headers.map((header, columnIndex) => {
    const { concept, strong } = proposeConceptForHeader(header);
    const isDuplicateHeader = (nameCounts.get((header || '').trim()) ?? 0) > 1;
    const confidence: Confidence = isDuplicateHeader ? 'auto_low' : strong ? 'auto_high' : concept === 'unmapped' ? 'auto_low' : 'auto_low';
    const d = defaultsFor(concept);
    return {
      columnIndex,
      sourceColumnName: header,
      mappedConcept: concept,
      confidence,
      isSearchable: d.searchable,
      isFilterable: d.filterable,
      visibility: d.visibility,
    };
  });
}

/**
 * Overlays previously-CONFIRMED mappings (from a prior import of the same
 * agreement + logical_source_key) onto freshly proposed ones. Matched by
 * (column_index, source_column_name) together — amendment 2 — so a column
 * that shifted position or was renamed falls back to a fresh proposal
 * instead of silently inheriting the wrong meaning.
 */
export async function overlayPersistedMappings(
  agreementId: string,
  logicalSourceKey: string,
  proposals: ColumnMappingProposal[],
): Promise<ColumnMappingProposal[]> {
  const { rows } = await pool.query(
    `SELECT column_index, source_column_name, mapped_concept, is_searchable, is_filterable, visibility, confidence
     FROM field_mappings WHERE agreement_id = $1 AND logical_source_key = $2 AND confidence != 'auto_low'`,
    [agreementId, logicalSourceKey],
  );
  const persisted = new Map<string, (typeof rows)[number]>();
  for (const r of rows) persisted.set(`${r.column_index}::${r.source_column_name}`, r);

  return proposals.map((p) => {
    const hit = persisted.get(`${p.columnIndex}::${p.sourceColumnName}`);
    if (!hit) return p;
    return {
      ...p,
      mappedConcept: hit.mapped_concept,
      confidence: hit.confidence === 'manual' ? 'manual' : p.confidence,
      isSearchable: hit.is_searchable,
      isFilterable: hit.is_filterable,
      visibility: hit.visibility,
    };
  });
}

export async function persistMapping(
  agreementId: string,
  logicalSourceKey: string,
  proposals: ColumnMappingProposal[],
  confirmedBy: string | null,
): Promise<void> {
  for (const p of proposals) {
    await pool.query(
      `INSERT INTO field_mappings (agreement_id, logical_source_key, column_index, source_column_name,
          mapped_concept, is_searchable, is_filterable, visibility, confidence, confirmed_by, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $9 = 'manual' THEN now() ELSE NULL END)
       ON CONFLICT (agreement_id, logical_source_key, column_index, source_column_name)
       DO UPDATE SET mapped_concept = EXCLUDED.mapped_concept, is_searchable = EXCLUDED.is_searchable,
          is_filterable = EXCLUDED.is_filterable, visibility = EXCLUDED.visibility,
          confidence = EXCLUDED.confidence, confirmed_by = EXCLUDED.confirmed_by,
          confirmed_at = CASE WHEN EXCLUDED.confidence = 'manual' THEN now() ELSE field_mappings.confirmed_at END,
          updated_at = now()`,
      [agreementId, logicalSourceKey, p.columnIndex, p.sourceColumnName, p.mappedConcept, p.isSearchable, p.isFilterable, p.visibility, p.confidence, confirmedBy],
    );
  }
}

/** True only when every column has a confident (auto_high or manual) mapping decision — used to gate auto-progression past the manual mapping screen. */
export function allColumnsConfident(proposals: ColumnMappingProposal[]): boolean {
  return proposals.every((p) => p.confidence === 'auto_high' || p.confidence === 'manual' || p.mappedConcept === 'unmapped' || p.mappedConcept === 'internal_only');
}

export interface MappingConflict {
  concept: MappedConcept;
  columns: { columnIndex: number; sourceColumnName: string }[];
}

export interface AnnotatedMappingProposal extends ColumnMappingProposal {
  hasConflict: boolean;
  conflictWith: number[]; // columnIndex list of the OTHER columns sharing this concept
}

/**
 * "تنبيه تعارض الـMapping": flags every case where TWO OR MORE columns —
 * regardless of whether their literal header text matches — are proposed
 * for the SAME mapped_concept within one (agreement, logical_source_key).
 * This is deliberately non-blocking (some multi-column-per-concept setups
 * are legitimate, e.g. an agreement that really does have two supplier-name
 * columns for different roles) — it only guarantees the conflict can never
 * pass silently: Admin sees an explicit warning naming every column
 * involved, and picking one column over another is never done for them
 * automatically. Every column keeps its own raw_data value regardless.
 */
export function annotateConflicts(proposals: ColumnMappingProposal[]): { annotated: AnnotatedMappingProposal[]; conflicts: MappingConflict[] } {
  const IGNORED: MappedConcept[] = ['unmapped', 'internal_only'];
  const byConcept = new Map<MappedConcept, { columnIndex: number; sourceColumnName: string }[]>();

  for (const p of proposals) {
    if (IGNORED.includes(p.mappedConcept)) continue;
    const list = byConcept.get(p.mappedConcept) ?? [];
    list.push({ columnIndex: p.columnIndex, sourceColumnName: p.sourceColumnName });
    byConcept.set(p.mappedConcept, list);
  }

  const conflicts: MappingConflict[] = [];
  for (const [concept, cols] of byConcept) {
    if (cols.length > 1) conflicts.push({ concept, columns: cols });
  }

  const conflictMap = new Map<MappedConcept, number[]>();
  for (const c of conflicts) conflictMap.set(c.concept, c.columns.map((x) => x.columnIndex));

  const annotated = proposals.map((p) => {
    const columnsForConcept = conflictMap.get(p.mappedConcept);
    if (!columnsForConcept) return { ...p, hasConflict: false, conflictWith: [] };
    return { ...p, hasConflict: true, conflictWith: columnsForConcept.filter((idx) => idx !== p.columnIndex) };
  });

  return { annotated, conflicts };
}
