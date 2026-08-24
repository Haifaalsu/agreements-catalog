"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Seeds the starter synonym dictionary requested for the Search Engine.
 * Safe to re-run (idempotent by canonical_term). Admin can add/edit more
 * later via /api/admin/synonyms — this script only bootstraps the initial set.
 */
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pool_1 = require("../db/pool");
const GROUPS = [
    // NOTE: "notebook" is deliberately NOT included as an English synonym for
    // لابتوب/laptop — it is genuinely ambiguous in the real data: 91 real
    // Office Supplies products use "Notebook" to mean a paper notebook (e.g.
    // "دفتر ملاحظات" / "Notebook"), while zero IT Devices laptop products use
    // that word (they all say "Laptop"). Including it caused a real search
    // bug: q=لابتوب surfaced paper notebooks above actual laptops. Caught
    // during real-data testing, same class of issue as the diesel/petrol fix.
    { canonical: 'لابتوب', terms: [
            { term: 'لابتوب', language: 'ar' }, { term: 'حاسب محمول', language: 'ar' }, { term: 'كمبيوتر محمول', language: 'ar' },
            { term: 'laptop', language: 'en' },
        ] },
    { canonical: 'طابعة', terms: [
            { term: 'طابعة', language: 'ar' }, { term: 'printer', language: 'en' },
        ] },
    { canonical: 'شاشة', terms: [
            { term: 'شاشة', language: 'ar' }, { term: 'monitor', language: 'en' }, { term: 'display', language: 'en' },
        ] },
    { canonical: 'جوال', terms: [
            { term: 'جوال', language: 'ar' }, { term: 'هاتف', language: 'ar' }, { term: 'موبايل', language: 'ar' },
            { term: 'mobile', language: 'en' }, { term: 'smartphone', language: 'en' }, { term: 'phone', language: 'en' },
        ] },
    { canonical: 'سيارة', terms: [
            { term: 'سيارة', language: 'ar' }, { term: 'مركبة', language: 'ar' }, { term: 'vehicle', language: 'en' }, { term: 'car', language: 'en' },
        ] },
    { canonical: 'سحابي', terms: [
            { term: 'سحابي', language: 'ar' }, { term: 'سحابة', language: 'ar' }, { term: 'cloud', language: 'en' },
        ] },
    { canonical: 'مايكروسوفت', terms: [
            { term: 'مايكروسوفت', language: 'ar' }, { term: 'مايكروسوفت', language: 'ar' }, { term: 'microsoft', language: 'en' },
        ] },
    { canonical: 'أحبار', terms: [
            { term: 'أحبار', language: 'ar' }, { term: 'حبر', language: 'ar' }, { term: 'ink', language: 'en' }, { term: 'toner', language: 'en' },
        ] },
    { canonical: 'استضافة', terms: [
            { term: 'استضافة', language: 'ar' }, { term: 'hosting', language: 'en' },
        ] },
    // NOTE: diesel/petrol are deliberately NOT grouped with "وقود" (fuel) —
    // they are distinct products in the real Fuel agreement data, not
    // interchangeable terms. Grouping them would make a "ديزل" search wrongly
    // surface petrol products too (caught during real-data testing).
    { canonical: 'وقود', terms: [
            { term: 'وقود', language: 'ar' }, { term: 'fuel', language: 'en' },
        ] },
    { canonical: 'ديزل', terms: [
            { term: 'ديزل', language: 'ar' }, { term: 'diesel', language: 'en' },
        ] },
    { canonical: 'بنزين', terms: [
            { term: 'بنزين', language: 'ar' }, { term: 'petrol', language: 'en' }, { term: 'gasoline', language: 'en' },
        ] },
    { canonical: 'قاعة', terms: [
            { term: 'قاعة', language: 'ar' }, { term: 'قاعات', language: 'ar' }, { term: 'hall', language: 'en' },
        ] },
];
async function main() {
    for (const g of GROUPS) {
        const existing = await pool_1.pool.query(`SELECT id FROM synonym_groups WHERE canonical_term = $1`, [g.canonical]);
        let groupId;
        if (existing.rows.length > 0) {
            groupId = existing.rows[0].id;
        }
        else {
            const inserted = await pool_1.pool.query(`INSERT INTO synonym_groups (canonical_term) VALUES ($1) RETURNING id`, [g.canonical]);
            groupId = inserted.rows[0].id;
        }
        for (const t of g.terms) {
            await pool_1.pool.query(`INSERT INTO synonym_terms (synonym_group_id, term, language) VALUES ($1,$2,$3) ON CONFLICT (synonym_group_id, term) DO NOTHING`, [groupId, t.term, t.language]);
        }
    }
    console.log(`Seeded ${GROUPS.length} synonym groups.`);
    await pool_1.pool.end();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=seedSynonyms.js.map