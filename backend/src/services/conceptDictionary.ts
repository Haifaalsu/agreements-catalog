/**
 * Keyword dictionary used by the Field Mapper to PROPOSE a mapping for each
 * raw Excel column header. This never runs blind — every proposal carries a
 * confidence level, and anything not 'auto_high' is surfaced to Admin for
 * manual confirmation on the "ربط الأعمدة" screen (see fieldMapper.ts).
 *
 * Built directly from the column headers actually observed across the 11
 * real agreement files during Phase 1 inspection (see Phase 1 report,
 * section 3 — "الحقول المشتركة فعليًا بين الملفات").
 */
import { MappedConcept } from '../types';
import { normalizeHeaderKey } from './textNormalize';

interface Rule {
  concept: MappedConcept;
  // All patterns are matched against the normalized header text.
  // `must` = at least one required to match; `mustNot` = disqualifies match.
  must: string[];
  mustNot?: string[];
  strong?: boolean; // strong, unambiguous keyword -> auto_high
}

// Order matters: more specific rules first (e.g. "model" must be checked
// before generic "manufacturer" because "رقم الموديل/المصنع" contains both
// "موديل" and "مصنع" but the column is really a combined Model field).
const RULES: Rule[] = [
  // --- identifiers -----------------------------------------------------
  { concept: 'product_id', must: ['رقم المنتج', 'رمز المنتج', 'كود المنتج', 'product id', 'product code', 'item code'], strong: true },
  { concept: 'supplier_id', must: ['رقم المورد', 'رمز المورد', 'supplier id', 'vendor id'], strong: true },
  { concept: 'contract_number', must: ['رقم العقد', 'contract number', 'contract id'], strong: true },
  { concept: 'grouping_id', must: ['grouping id'], strong: true },

  // --- supplier ----------------------------------------------------------
  { concept: 'supplier_name', must: ['اسم المورد', 'المورد', 'supplier name', 'supplier', 'vendor'], mustNot: ['رقم', 'رمز', ' id'], strong: true },

  // --- category (level-aware) --------------------------------------------
  { concept: 'category_l1', must: ['المستوى الاول', 'l1', 'مستوى اول'], strong: true },
  { concept: 'category_l2', must: ['المستوى الثاني', 'l2', 'مستوى ثاني'], strong: true },
  { concept: 'category_l3', must: ['المستوى الثالث', 'l3', 'مستوى ثالث'], strong: true },
  { concept: 'category_l1', must: ['فئه المنتج', 'فئة المنتج', 'فئة الخدم', 'التصنيف', 'category', 'classification', 'product cateogry'], mustNot: ['رقم', 'كود', 'id'], strong: false },

  // --- names / descriptions (language-aware) ------------------------------
  // English-labelled columns explicitly marked "(Arabic)" / "بالعربي" etc.
  // (a real, confirmed pattern: "Product Desription (Arabic)") MUST be
  // checked before the generic English-description rule below, otherwise
  // the English marker "product desription" alone would misfire.
  // NOTE: every pattern here matched a real bug during testing where a
  // column literally titled "...40 حرف إنجليزي" (English) got matched as
  // Arabic because it also contains the bare phrase "وصف قصير للمنتج"
  // earlier in its (multi-line) header. Every pattern below is therefore
  // required to ALSO exclude the opposite-language marker explicitly,
  // rather than relying on rule order alone.
  { concept: 'description_ar', must: ['وصف المنتج بالعربي', 'وصف قصير للمنتج 40 حرف عربي', 'وصف قصير للخدمه', 'وصف المنتج (عربي', 'وصف المنتج عربي', 'وصف قصير للمنتج', 'desription (arabic', 'description (arabic', 'desription(arabic', 'description(arabic'], mustNot: ['انجليزي', 'english'], strong: true },
  { concept: 'description_en', must: ['product description', 'وصف المنتج بالانجليزي', 'وصف المنتج (انجليزي', 'وصف المنتج انجليزي', 'product desription'], mustNot: ['عربي', 'arabic'], strong: true },
  { concept: 'description_ar', must: ['وصف المنتج', 'وصف الخدمه'], mustNot: ['english', 'انجليزي'], strong: false },

  // --- manufacturer / model (order matters: model first) -----------------
  { concept: 'model', must: ['موديل', 'model'], strong: true },
  { concept: 'manufacturer', must: ['العلامه التجاريه', 'الشركه المصنعه', 'مصنع', 'manufacturer', 'brand'], mustNot: ['موديل', 'model'], strong: true },

  // --- physical / logistics -----------------------------------------------
  { concept: 'country_of_origin', must: ['بلد المنشا', 'country of origin'], strong: true },
  { concept: 'unit', must: ['وحده القياس', 'وحده الشراء', 'order unit', 'الوحده'], mustNot: ['سعر', 'price'], strong: true },
];

export function proposeConceptForHeader(headerText: string): { concept: MappedConcept; strong: boolean } {
  const norm = normalizeHeaderKey(headerText);
  if (!norm) return { concept: 'unmapped', strong: false };

  // Explicit "internal use only" markers.
  if (/\bhide\b|\binternal\b|مخفي/.test(norm)) {
    return { concept: 'internal_only', strong: true };
  }

  for (const rule of RULES) {
    const hasMust = rule.must.some((p) => norm.includes(normalizeHeaderKey(p)));
    if (!hasMust) continue;
    const hasMustNot = (rule.mustNot ?? []).some((p) => norm.includes(normalizeHeaderKey(p)));
    if (hasMustNot) continue;
    return { concept: rule.concept, strong: !!rule.strong };
  }

  return { concept: 'unmapped', strong: false };
}
