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
exports.searchRouter.get('/facets', async (req, res) => {
    const query = String(req.query.q || '');
    const filters = parseFilters(req.query);
    const facets = await (0, searchService_1.computeFacets)({ query, filters, page: 1, pageSize: 20, sort: 'relevance' });
    res.json(facets);
});
//# sourceMappingURL=search.js.map