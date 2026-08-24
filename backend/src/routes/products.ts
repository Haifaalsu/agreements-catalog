import { Router } from 'express';
import { getProductDetail } from '../services/productService';
import { verifyToken } from '../services/authService';

export const productsRouter = Router();

productsRouter.get('/:id', async (req, res) => {
  // Optional auth: an admin token unlocks admin_only/hidden raw_data fields; anonymous users get the filtered view.
  let isAdmin = false;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const payload = verifyToken(header.slice('Bearer '.length));
    if (payload) isAdmin = true;
  }
  const detail = await getProductDetail(req.params.id, isAdmin);
  if (!detail) return res.status(404).json({ error: 'غير موجود' });
  res.json(detail);
});
