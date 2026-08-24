import { Router } from 'express';
import { getStatsSummary } from '../services/productService';

export const statsRouter = Router();

statsRouter.get('/', async (_req, res) => {
  res.json(await getStatsSummary());
});
