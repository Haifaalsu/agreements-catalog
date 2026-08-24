import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/authService';

export interface AuthedRequest extends Request {
  user?: { id: string; role: string };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
  }
  const token = header.slice('Bearer '.length);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'جلسة غير صالحة أو منتهية' });
  req.user = payload;
  next();
}

export function requireSuperAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'صلاحية غير كافية' });
  next();
}
