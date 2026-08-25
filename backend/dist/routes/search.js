"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchRouter = void 0;
const express_1 = require("express");
const searchService_1 = require("../services/searchService");
exports.searchRouter = (0, express_1.Router)();
function parseFilters(q) {
    return {
        agreementId: q.agreementId || undefined,
        categoryL1: q.categoryL1 || undefined,
        categoryL2: q.categoryL2 || undefined,
        categoryL3: q.categoryL3 || undefined,
        supplierName: q.supplierName || undefined,
        manufacturer: q.manufacturer || undefined,
        countryOfOrigin: q.countryOfOrigin || undefined,
        unit: q.unit || undefined,
        sourceFileName: q.sourceFileName || undefined,
    };
}
exports.searchRouter.get('/', async (req, res) => {
    const query = String(req.query.q || '');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const sort = (['relevance', 'name', 'agreement', 'supplier'].includes(String(req.query.sort)) ? req.query.sort : 'relevance');
    const filters = parseFilters(req.query);
    const result = await (0, searchService_1.search)({ query, filters, page, pageSize, sort });
    res.json(result);
});
// computeFacets() runs several extra grouped aggregate queries beyond the
// main search query — noticeably heavier, and the exact same (q, filters)
// pair is requested repeatedly in normal use (every employee who opens the
// filters drawer without having changed their search text). A short-lived
// in-memory cache means those repeats are free instead of re-hitting the
// database — safe because a few seconds of staleness in filter *option
// lists/counts* is harmless (search results themselves are never cached).
const FACETS_CACHE_TTL_MS = 20000;
const facetsCache = new Map();
exports.searchRouter.get('/facets', async (req, res) => {
    const query = String(req.query.q || '');
    const filters = parseFilters(req.query);
    const cacheKey = JSON.stringify({ query, filters });
    const cached = facetsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FACETS_CACHE_TTL_MS) {
        res.json(cached.data);
        return;
    }
    const facets = await (0, searchService_1.computeFacets)({ query, filters, page: 1, pageSize: 20, sort: 'relevance' });
    facetsCache.set(cacheKey, { at: Date.now(), data: facets });
    // Simple unbounded-growth guard — this is a small, low-cardinality
    // cache in practice (distinct search terms people actually type), but
    // never let it grow forever if something unexpected happens.
    if (facetsCache.size > 500) {
        const oldestKey = facetsCache.keys().next().value;
        if (oldestKey !== undefined)
            facetsCache.delete(oldestKey);
    }
    res.json(facets);
});
//# sourceMappingURL=search.js.map