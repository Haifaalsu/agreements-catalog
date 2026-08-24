import { pool } from '../db/pool';

/** Rebuilds the ordered, de-duplicated raw_data key list for a source (mirrors rowProjector's suffixing) so admin_only/hidden columns can be located by name regardless of JSONB key order. */
function rebuildRawKeys(headerColumns: string[]): string[] {
  const seen = new Map<string, number>();
  return headerColumns.map((h) => {
    const key = (h || '').trim() || h;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence === 1 ? key : `${key} (${occurrence})`;
  });
}

async function getHiddenRawKeys(agreementId: string, logicalSourceKey: string, headerColumns: string[]): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT column_index, source_column_name FROM field_mappings
     WHERE agreement_id = $1 AND logical_source_key = $2 AND visibility IN ('admin_only','hidden')`,
    [agreementId, logicalSourceKey],
  );
  if (rows.length === 0) return new Set();
  const rawKeys = rebuildRawKeys(headerColumns);
  const hidden = new Set<string>();
  for (const r of rows) {
    const key = rawKeys[r.column_index];
    if (key) hidden.add(key);
  }
  return hidden;
}

export interface ProductDetail {
  id: string;
  agreementId: string;
  agreementSlug: string;
  agreementNameAr: string;
  mapped: Record<string, string | null>;
  rawData: Record<string, any>;
  source: { fileName: string; sheetName: string; importedAt: string };
  siblings: { id: string; supplierName: string | null; rawData: Record<string, any>; mapped: Record<string, string | null> }[];
}

/**
 * Fetches one product row PLUS every sibling row sharing the same
 * (agreement_id, mapped_product_id) — the "متوفر لدى X موردين" case. Rows
 * are never merged: each sibling keeps its own full raw_data and mapped
 * fields, exactly as imported.
 */
export async function getProductDetail(productId: string, isAdmin: boolean): Promise<ProductDetail | null> {
  const { rows } = await pool.query(
    `SELECT p.*, a.slug AS agreement_slug, a.name_ar AS agreement_name_ar,
            s.original_file_name, s.sheet_name, s.imported_at, s.logical_source_key, s.header_columns
     FROM products p
     JOIN agreements a ON a.id = p.agreement_id
     JOIN sources s ON s.id = p.source_id
     WHERE p.id = $1`,
    [productId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const hiddenKeys = isAdmin ? new Set<string>() : await getHiddenRawKeys(row.agreement_id, row.logical_source_key, row.header_columns ?? []);
  const filterRaw = (raw: Record<string, any>) => {
    if (hiddenKeys.size === 0) return raw;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) if (!hiddenKeys.has(k)) out[k] = v;
    return out;
  };

  const mappedOf = (r: any) => ({
    product_id: r.mapped_product_id, name_ar: r.mapped_name_ar, name_en: r.mapped_name_en,
    description_ar: r.mapped_description_ar, description_en: r.mapped_description_en,
    supplier_name: r.mapped_supplier_name, category_l1: r.mapped_category_l1, category_l2: r.mapped_category_l2,
    category_l3: r.mapped_category_l3, manufacturer: r.mapped_manufacturer, model: r.mapped_model,
    country_of_origin: r.mapped_country_of_origin, unit: r.mapped_unit,
  });

  let siblings: ProductDetail['siblings'] = [];
  if (row.mapped_product_id) {
    // Real bug found + fixed during Phase 4 testing: this query used to match
    // siblings by (agreement_id, mapped_product_id) alone, with no source
    // filter — so after a re-import replaced a source (e.g. fuel), the OLD
    // 'replaced' source's rows were STILL counted as suppliers here (search
    // itself was already correct, since searchService always filters
    // s.status='active' — only this per-product detail lookup wasn't). For
    // the real diesel product (20037003) this inflated "متوفر لدى" from the
    // correct 6 active suppliers to 12 (6 active + 6 stale/replaced). Fixed
    // by requiring the sibling's source to be active + visible, matching
    // search's own visibility rule exactly.
    const sib = await pool.query(
      `SELECT p.* FROM products p
       JOIN sources s ON s.id = p.source_id
       WHERE p.agreement_id = $1 AND p.mapped_product_id = $2 AND p.id <> $3
         AND s.status = 'active' AND (s.is_visible_to_users = TRUE OR $4::boolean)`,
      [row.agreement_id, row.mapped_product_id, row.id, isAdmin],
    );
    siblings = sib.rows.map((r) => ({ id: r.id, supplierName: r.mapped_supplier_name, rawData: filterRaw(r.raw_data), mapped: mappedOf(r) }));
  }

  return {
    id: row.id,
    agreementId: row.agreement_id,
    agreementSlug: row.agreement_slug,
    agreementNameAr: row.agreement_name_ar,
    mapped: mappedOf(row),
    rawData: filterRaw(row.raw_data),
    source: { fileName: row.original_file_name, sheetName: row.sheet_name, importedAt: row.imported_at },
    siblings,
  };
}

export interface StatsSummary {
  totalProducts: number;
  totalAgreements: number;
  totalSuppliers: number;
  lastUpdatedAt: string | null;
}

export async function getStatsSummary(): Promise<StatsSummary> {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM products p JOIN sources s ON s.id=p.source_id WHERE s.status='active' AND s.is_visible_to_users) AS total_products,
      (SELECT count(*) FROM agreements WHERE status='active') AS total_agreements,
      (SELECT count(DISTINCT mapped_supplier_name) FROM products p JOIN sources s ON s.id=p.source_id WHERE s.status='active' AND s.is_visible_to_users AND mapped_supplier_name IS NOT NULL) AS total_suppliers,
      (SELECT max(imported_at) FROM sources WHERE status='active') AS last_updated_at
  `);
  const r = rows[0];
  return {
    totalProducts: Number(r.total_products),
    totalAgreements: Number(r.total_agreements),
    totalSuppliers: Number(r.total_suppliers),
    lastUpdatedAt: r.last_updated_at,
  };
}
