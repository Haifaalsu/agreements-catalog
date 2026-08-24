import { Router } from 'express';
import { search, computeFacets, SearchFilters, SortMode } from '../services/searchService';

export const searchRouter = Router();

function parseFilters(q: any): SearchFilters {
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

searchRouter.get('/', async (req, res) => {
  const query = String(req.query.q || '');
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const sort = (['relevance', 'name', 'agreement', 'supplier'].includes(String(req.query.sort)) ? req.query.sort : 'relevance') as SortMode;
  const filters = parseFilters(req.query);

  const result = await search({ query, filters, page, pageSize, sort });
  res.json(result);
});

searchRouter.get('/facets', async (req, res) => {
  const query = String(req.query.q || '');
  const filters = parseFilters(req.query);
  const facets = await computeFacets({ query, filters, page: 1, pageSize: 20, sort: 'relevance' });
  res.json(facets);
});
