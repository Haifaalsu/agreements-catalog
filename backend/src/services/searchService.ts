import { pool } from '../db/pool';
import { normalizeText } from './textNormalize';

interface SynonymEntry {
  groupId: string;
  term: string; // already normalized
}

let synonymCache: { loadedAt: number; byTerm: Map<string, string[]> } | null = null;
const SYNONYM_CACHE_TTL_MS = 60_000;

/** Loads (and briefly caches) the synonym dictionary, normalized, as term -> [all sibling terms incl. itself]. */
async function loadSynonymMap(): Promise<Map<string, string[]>> {
  if (synonymCache && Date.now() - synonymCache.loadedAt < SYNONYM_CACHE_TTL_MS) {
    return synonymCache.byTerm;
  }
  const { rows } = await pool.query<{ group_id: string; term: string }>(
    `SELECT synonym_group_id AS group_id, term FROM synonym_terms`,
  );
  const byGroup = new Map<string, string[]>();
  for (const r of rows) {
    const norm = normalizeText(r.term);
    if (!norm) continue;
    const list = byGroup.get(r.group_id) ?? [];
    list.push(norm);
    byGroup.set(r.group_id, list);
  }
  const byTerm = new Map<string, string[]>();
  for (const [, terms] of byGroup) {
    for (const t of terms) byTerm.set(t, terms);
  }
  synonymCache = { loadedAt: Date.now(), byTerm };
  return byTerm;
}

/** Splits + normalizes a free-text query into words, then expands each word to include its synonyms. */
export async function expandQueryWords(query: string): Promise<string[][]> {
  const normalized = normalizeText(query);
  const words = normalized.split(' ').filter(Boolean);
  const synonymMap = await loadSynonymMap();
  return words.map((w) => {
    const siblings = synonymMap.get(w);
    return siblings ? Array.from(new Set([w, ...siblings])) : [w];
  });
}

export interface SearchFilters {
  agreementId?: string;
  categoryL1?: string;
  categoryL2?: string;
  categoryL3?: string;
  supplierName?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  unit?: string;
  sourceFileName?: string;
}

export type SortMode = 'relevance' | 'name' | 'agreement' | 'supplier';

export interface SearchParams {
  query: string;
  filters: SearchFilters;
  page: number;
  pageSize: number;
  sort: SortMode;
}

export interface SearchResultItem {
  groupKey: string;
  agreementId: string;
  agreementSlug: string;
  agreementNameAr: string;
  productId: string | null;
  nameAr: string | null;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  categoryL3: string | null;
  manufacturer: string | null;
  model: string | null;
  supplierName: string | null;
  supplierCount: number;
  representativeProductRowId: string;
  relevanceScore: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  page: number;
  pageSize: number;
  tookMs: number;
}

/**
 * Core relevance-ordered search. Priority (per spec):
 *  1. Exact Product ID/SKU   2. Exact name/description   3. Partial name/description
 *  4. (folded into 2/3 — see note below)   5. Category   6. Manufacturer/Model
 *  7. Supplier   8. Everything else (raw_data full-text fallback)
 *
 * Note: across the 11 real agreement files inspected in Phase 1, ~10 of 11
 * have NO column distinct from "product description" that plays the role of
 * a separate "name" — so name/description are scored as one combined tier
 * (search_norm_identity) rather than faking a name field that doesn't exist
 * in the source data. Digital Circuits (configurator-type) is excluded here
 * entirely — it never appears in general search results (see configurator.ts).
 */
export async function search(params: SearchParams): Promise<SearchResponse> {
  const startedAt = Date.now();
  const wordGroups = params.query.trim() ? await expandQueryWords(params.query) : [];

  const whereClauses: string[] = [`a.display_type = 'standard'`, `s.status = 'active'`, `s.is_visible_to_users = TRUE`];
  const values: any[] = [];
  let scoreExpr = '0';

  const push = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };

  // One AND-ed condition per query word; each word may match via any of its
  // synonym alternatives (OR), in any of the five weighted columns (OR), OR
  // (tier 8) anywhere in raw_data via the full-text search_vector.
  //
  // NOTE — real gap found + fixed during Phase 4 testing: tier 8 ("حقول بحث
  // إضافية" / additional searchable fields, e.g. an "Additional Details"
  // column an admin flagged Searchable) was originally scored via
  // ts_rank_cd(search_vector, ...) but NEVER added to the WHERE clause —
  // since ts_rank_cd only affects ORDER, a row matching *only* through
  // raw_data (nothing in the five weighted columns) never passed the WHERE
  // filter at all and was silently excluded, no matter its score. Concretely:
  // real Microsoft data has "Azure Active Directory Premium P1" inside an
  // Additional Details column, but q=azure returned zero results. Fixed by
  // OR-ing a `search_vector @@ tsquery` condition (backed by the existing
  // GIN index on search_vector) into the same per-word WHERE clause, so tier
  // 8 now actually participates in inclusion, not just ranking.
  const wordScoreTerms: string[] = [];
  for (const alternatives of wordGroups) {
    const patterns = alternatives.map((a) => `%${a}%`);
    const exactPh = push(alternatives);
    const partialPh = push(patterns);
    const tsqueryExpr = alternatives.map((a) => `plainto_tsquery('simple', ${push(a)})`).join(' || ');
    whereClauses.push(
      `(search_norm_product_id ILIKE ANY(${partialPh}) OR search_norm_identity ILIKE ANY(${partialPh}) OR
        search_norm_category ILIKE ANY(${partialPh}) OR search_norm_manufacturer_model ILIKE ANY(${partialPh}) OR
        search_norm_supplier ILIKE ANY(${partialPh}) OR search_vector @@ (${tsqueryExpr}))`,
    );
    wordScoreTerms.push(`
      (CASE
        WHEN search_norm_product_id = ANY(${exactPh}) THEN 1000
        WHEN search_norm_product_id ILIKE ANY(${partialPh}) THEN 700
        WHEN search_norm_identity = ANY(${exactPh}) THEN 500
        WHEN search_norm_identity ILIKE ANY(${partialPh}) THEN 400
        WHEN search_norm_category ILIKE ANY(${partialPh}) THEN 150
        WHEN search_norm_manufacturer_model ILIKE ANY(${partialPh}) THEN 100
        WHEN search_norm_supplier ILIKE ANY(${partialPh}) THEN 60
        WHEN search_vector @@ (${tsqueryExpr}) THEN 20
        ELSE 0
      END)`);
  }
  if (wordScoreTerms.length > 0) {
    scoreExpr = wordScoreTerms.join(' + ');
  }

  // Tier 8 fallback: generic full-text rank across raw_data + mapped fields,
  // scaled small so it only breaks ties / surfaces matches in "other" fields
  // not covered by the five weighted columns above (e.g. free-text spec sheets).
  let tsRankExpr = '0';
  if (params.query.trim()) {
    const qPh = push(params.query.trim());
    tsRankExpr = `COALESCE(ts_rank_cd(search_vector, plainto_tsquery('simple', ${qPh})), 0) * 5`;
  }

  const f = params.filters;
  if (f.agreementId) whereClauses.push(`a.id = ${push(f.agreementId)}`);
  if (f.categoryL1) whereClauses.push(`p.mapped_category_l1 = ${push(f.categoryL1)}`);
  if (f.categoryL2) whereClauses.push(`p.mapped_category_l2 = ${push(f.categoryL2)}`);
  if (f.categoryL3) whereClauses.push(`p.mapped_category_l3 = ${push(f.categoryL3)}`);
  if (f.supplierName) whereClauses.push(`p.mapped_supplier_name = ${push(f.supplierName)}`);
  if (f.manufacturer) whereClauses.push(`p.mapped_manufacturer = ${push(f.manufacturer)}`);
  if (f.countryOfOrigin) whereClauses.push(`p.mapped_country_of_origin = ${push(f.countryOfOrigin)}`);
  if (f.unit) whereClauses.push(`p.mapped_unit = ${push(f.unit)}`);
  if (f.sourceFileName) whereClauses.push(`s.original_file_name = ${push(f.sourceFileName)}`);

  const whereSql = whereClauses.map((c) => `(${c})`).join(' AND ');
  const fullScoreExpr = `(${scoreExpr}) + ${tsRankExpr}`;

  // NOTE: must reference the raw mapped_* column names (best = products,
  // see below) — not the outer SELECT's output aliases (name_ar / description_ar /
  // supplier_name), which don't exist as real columns. Referencing the
  // aliases here was a latent bug that would throw "column does not exist"
  // the first time sort=name or sort=supplier was actually exercised.
  const orderSql =
    params.sort === 'name' ? `best.mapped_name_ar NULLS LAST, best.mapped_description_ar NULLS LAST` :
    params.sort === 'agreement' ? `a.name_ar, group_relevance DESC` :
    params.sort === 'supplier' ? `best.mapped_supplier_name NULLS LAST, group_relevance DESC` :
    `group_relevance DESC`;

  const limitPh = push(params.pageSize);
  const offsetPh = push((params.page - 1) * params.pageSize);

  // PERFORMANCE NOTE (real bug found + fixed during Phase 4 testing):
  // `scored` used to SELECT p.* (the full row incl. raw_data/mapped_attributes
  // JSONB) and the final SELECT re-joined back into that same CTE a SECOND
  // time (`JOIN scored best ON best.id = grouped.representative_id`) to fetch
  // each group's representative row. For a narrow, filtered search this was
  // fine (few matching rows). But for the *empty-query browse-all* case — the
  // very first thing every visitor's homepage load actually runs — nothing
  // narrows `scored` at all (~126k rows), so Postgres's cost estimator badly
  // under-counted the join cardinality and picked a plan that rescanned the
  // whole materialized CTE once per group (tens of thousands of groups) —
  // confirmed via EXPLAIN ANALYZE to hang 5+ minutes / time out entirely.
  // Fix: (1) trim `scored`'s SELECT list to only the columns actually needed
  // downstream (no raw_data/mapped_attributes ever leaves this query — detail
  // fetches go through /api/products/:id instead), and (2) re-join the
  // representative row directly against `products` (indexed on its primary
  // key) instead of back into `scored`, so the lookup is an Index Scan per
  // group rather than a full re-scan. Verified: empty-query browse now
  // returns in well under a second at full 130k-row scale (see final report).
  const sql = `
    WITH scored AS (
      SELECT p.id, p.agreement_id, p.created_at, p.mapped_product_id,
             p.mapped_name_ar, p.mapped_name_en, p.mapped_description_ar, p.mapped_description_en,
             p.mapped_category_l1, p.mapped_category_l2, p.mapped_category_l3,
             p.mapped_manufacturer, p.mapped_model, p.mapped_supplier_name,
             (${fullScoreExpr}) AS relevance_score,
             COALESCE(p.mapped_product_id, p.id::text) AS group_key
      FROM products p
      JOIN sources s ON s.id = p.source_id
      JOIN agreements a ON a.id = p.agreement_id
      WHERE ${whereSql}
    ),
    grouped AS (
      SELECT agreement_id, group_key,
             count(*) AS supplier_count,
             max(relevance_score) AS group_relevance,
             (array_agg(id ORDER BY relevance_score DESC, created_at))[1] AS representative_id
      FROM scored
      GROUP BY agreement_id, group_key
    )
    SELECT grouped.group_key, grouped.agreement_id, grouped.supplier_count, grouped.group_relevance,
           best.id AS representative_row_id, best.mapped_product_id AS product_id,
           best.mapped_name_ar AS name_ar, best.mapped_name_en AS name_en,
           best.mapped_description_ar AS description_ar, best.mapped_description_en AS description_en,
           best.mapped_category_l1 AS category_l1, best.mapped_category_l2 AS category_l2, best.mapped_category_l3 AS category_l3,
           best.mapped_manufacturer AS manufacturer, best.mapped_model AS model, best.mapped_supplier_name AS supplier_name,
           a.slug AS agreement_slug, a.name_ar AS agreement_name_ar,
           count(*) OVER() AS total_groups
    FROM grouped
    JOIN products best ON best.id = grouped.representative_id
    JOIN agreements a ON a.id = grouped.agreement_id
    ORDER BY ${orderSql}
    LIMIT ${limitPh} OFFSET ${offsetPh}
  `;

  const { rows } = await pool.query(sql, values);
  const total = rows.length > 0 ? Number(rows[0].total_groups) : 0;

  const results: SearchResultItem[] = rows.map((r) => ({
    groupKey: r.group_key,
    agreementId: r.agreement_id,
    agreementSlug: r.agreement_slug,
    agreementNameAr: r.agreement_name_ar,
    productId: r.product_id,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    descriptionAr: r.description_ar,
    descriptionEn: r.description_en,
    categoryL1: r.category_l1,
    categoryL2: r.category_l2,
    categoryL3: r.category_l3,
    manufacturer: r.manufacturer,
    model: r.model,
    supplierName: r.supplier_name,
    supplierCount: Number(r.supplier_count),
    representativeProductRowId: r.representative_row_id,
    relevanceScore: Number(r.group_relevance),
  }));

  return { results, total, page: params.page, pageSize: params.pageSize, tookMs: Date.now() - startedAt };
}

export interface FacetValue {
  value: string;
  count: number;
}
export interface Facets {
  agreements: (FacetValue & { slug: string; nameAr: string })[];
  categoriesL1: FacetValue[];
  suppliers: FacetValue[];
  manufacturers: FacetValue[];
  countriesOfOrigin: FacetValue[];
  units: FacetValue[];
}

/**
 * Dynamic filters: only ever computed from — and therefore only ever show —
 * values that actually occur in the CURRENT result set. A filter with zero
 * distinct values is omitted by the caller (empty array = "don't render").
 */
export async function computeFacets(params: SearchParams): Promise<Facets> {
  const wordGroups = params.query.trim() ? await expandQueryWords(params.query) : [];
  const whereClauses: string[] = [`a.display_type = 'standard'`, `s.status = 'active'`, `s.is_visible_to_users = TRUE`];
  const values: any[] = [];
  const push = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };
  for (const alternatives of wordGroups) {
    const patterns = alternatives.map((a) => `%${a}%`);
    const partialPh = push(patterns);
    // Kept in sync with search()'s tier-8 WHERE fix above — facets must be
    // computed over the exact same row set search() returns, or a filter
    // could show counts for rows that never actually appear in the results.
    const tsqueryExpr = alternatives.map((a) => `plainto_tsquery('simple', ${push(a)})`).join(' || ');
    whereClauses.push(
      `(search_norm_product_id ILIKE ANY(${partialPh}) OR search_norm_identity ILIKE ANY(${partialPh}) OR
        search_norm_category ILIKE ANY(${partialPh}) OR search_norm_manufacturer_model ILIKE ANY(${partialPh}) OR
        search_norm_supplier ILIKE ANY(${partialPh}) OR search_vector @@ (${tsqueryExpr}))`,
    );
  }
  const f = params.filters;
  if (f.agreementId) whereClauses.push(`a.id = ${push(f.agreementId)}`);
  if (f.categoryL1) whereClauses.push(`p.mapped_category_l1 = ${push(f.categoryL1)}`);
  if (f.categoryL2) whereClauses.push(`p.mapped_category_l2 = ${push(f.categoryL2)}`);
  if (f.categoryL3) whereClauses.push(`p.mapped_category_l3 = ${push(f.categoryL3)}`);
  if (f.supplierName) whereClauses.push(`p.mapped_supplier_name = ${push(f.supplierName)}`);
  if (f.manufacturer) whereClauses.push(`p.mapped_manufacturer = ${push(f.manufacturer)}`);
  if (f.countryOfOrigin) whereClauses.push(`p.mapped_country_of_origin = ${push(f.countryOfOrigin)}`);
  if (f.unit) whereClauses.push(`p.mapped_unit = ${push(f.unit)}`);
  const whereSql = whereClauses.map((c) => `(${c})`).join(' AND ');

  const baseFrom = `FROM products p JOIN sources s ON s.id = p.source_id JOIN agreements a ON a.id = p.agreement_id WHERE ${whereSql}`;

  async function facet(col: string, extra = ''): Promise<FacetValue[]> {
    const { rows } = await pool.query(
      `SELECT ${col} AS value, count(*)::int AS count ${baseFrom} AND ${col} IS NOT NULL ${extra} GROUP BY ${col} ORDER BY count DESC LIMIT 50`,
      values,
    );
    return rows;
  }

  const [agreementsRaw, categoriesL1, suppliers, manufacturers, countries, units] = await Promise.all([
    pool.query(`SELECT a.id AS value, a.slug, a.name_ar, count(*)::int AS count ${baseFrom} GROUP BY a.id, a.slug, a.name_ar ORDER BY count DESC`, values),
    facet('p.mapped_category_l1'),
    facet('p.mapped_supplier_name'),
    facet('p.mapped_manufacturer'),
    facet('p.mapped_country_of_origin'),
    facet('p.mapped_unit'),
  ]);

  return {
    // NOTE: real bug found + fixed here during Phase 4 testing — `value`
    // must stay the agreement's UUID (matching what /api/search's own
    // `agreementId` filter expects: `a.id = $1`). An earlier version
    // discarded the UUID and put name_ar in `value` instead, so selecting
    // this filter in the UI sent a name string where a UUID was expected
    // and the search query crashed with "invalid input syntax for type
    // uuid". `nameAr` is now separate, for display only.
    agreements: agreementsRaw.rows.map((r) => ({ value: r.value, slug: r.slug, nameAr: r.name_ar, count: r.count })),
    categoriesL1,
    suppliers,
    manufacturers,
    countriesOfOrigin: countries,
    units,
  };
}
