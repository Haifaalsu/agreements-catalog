import { Router } from 'express';
import { z } from 'zod';
import { verifyLogin, signToken } from '../services/authService';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'بيانات الدخول غير صحيحة' });

  const user = await verifyLogin(parsed.data.email, parsed.data.password);
  if (!user) return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });

  const token = signToken({ id: user.id, role: user.role });
  res.json({ token, user });
});
