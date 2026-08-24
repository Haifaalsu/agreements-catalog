import { pool } from '../db/pool';

export interface ConfiguratorDimension {
  attributeKey: string;
  labelAr: string;
  labelEn: string | null;
  stepOrder: number;
}

export async function getConfiguratorDimensions(agreementId: string): Promise<ConfiguratorDimension[]> {
  const { rows } = await pool.query(
    `SELECT attribute_key, label_ar, label_en, step_order FROM configurator_dimensions WHERE agreement_id = $1 ORDER BY step_order`,
    [agreementId],
  );
  return rows.map((r) => ({ attributeKey: r.attribute_key, labelAr: r.label_ar, labelEn: r.label_en, stepOrder: r.step_order }));
}

const DIRECT_COLUMNS: Record<string, string> = {
  category_l1: 'mapped_category_l1',
  category_l2: 'mapped_category_l2',
  category_l3: 'mapped_category_l3',
};

function valueExprFor(attributeKey: string): string {
  return DIRECT_COLUMNS[attributeKey] ?? `mapped_attributes->>'${attributeKey.replace(/[^a-z0-9_]/gi, '')}'`;
}

export interface ConfiguratorStepResult {
  nextDimension: ConfiguratorDimension | null; // null once every dimension is selected
  availableValues: { value: string; count: number }[];
  matches: Record<string, any>[]; // populated only when nextDimension is null
  totalMatches: number;
}

/**
 * Cascading step resolver: given the dimensions already chosen (in order),
 * returns the distinct available values for the NEXT dimension (narrowed by
 * every prior selection), or — once all dimensions are chosen — the actual
 * matching product row(s). Every step is answered against the indexed
 * mapped_category_l1/l2 columns and mapped_attributes expression indexes
 * (migration 003), never a raw_data scan, so it stays fast at 74k+ rows.
 */
export async function resolveConfiguratorStep(agreementId: string, selections: Record<string, string>): Promise<ConfiguratorStepResult> {
  const dimensions = await getConfiguratorDimensions(agreementId);

  const whereClauses = ['agreement_id = $1', `source_id IN (SELECT id FROM sources WHERE status='active' AND is_visible_to_users)`];
  const values: any[] = [agreementId];
  const push = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };

  let nextDimension: ConfiguratorDimension | null = null;
  for (const dim of dimensions) {
    const selectedValue = selections[dim.attributeKey];
    if (selectedValue === undefined) {
      nextDimension = dim;
      break;
    }
    whereClauses.push(`${valueExprFor(dim.attributeKey)} = ${push(selectedValue)}`);
  }

  const whereSql = whereClauses.join(' AND ');

  if (nextDimension) {
    const expr = valueExprFor(nextDimension.attributeKey);
    const { rows } = await pool.query(
      `SELECT ${expr} AS value, count(*)::int AS count FROM products WHERE ${whereSql} AND ${expr} IS NOT NULL GROUP BY ${expr} ORDER BY value`,
      values,
    );
    return { nextDimension, availableValues: rows, matches: [], totalMatches: 0 };
  }

  // All dimensions specified -> return the actual matching row(s), Digital
  // Circuits has no supplier/price so this is the "spec confirmed available
  // under this agreement" result, not a priced offer.
  const { rows } = await pool.query(
    `SELECT id, mapped_category_l1, mapped_category_l2, mapped_attributes, raw_data FROM products WHERE ${whereSql} LIMIT 20`,
    values,
  );
  return { nextDimension: null, availableValues: [], matches: rows, totalMatches: rows.length };
}
