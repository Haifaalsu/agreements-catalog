import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';

const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const TOKEN_TTL = '12h';

export async function verifyLogin(email: string, password: string) {
  const { rows } = await pool.query(`SELECT id, full_name, email, password_hash, role FROM users WHERE email = $1 AND is_active = TRUE`, [email]);
  const user = rows[0];
  if (!user || !user.password_hash) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, fullName: user.full_name, email: user.email, role: user.role };
}

export function signToken(payload: { id: string; role: string }) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): { id: string; role: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
