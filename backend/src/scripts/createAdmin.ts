/**
 * Bootstraps the first super_admin user.
 * Usage: npm run create-admin -- "الاسم الكامل" admin@example.com "كلمة المرور"
 */
import dotenv from 'dotenv';
dotenv.config();
import { pool } from '../db/pool';
import { hashPassword } from '../services/authService';

async function main() {
  const [fullName, email, password] = process.argv.slice(2);
  if (!fullName || !email || !password) {
    console.error('Usage: npm run create-admin -- "الاسم الكامل" admin@example.com "كلمة المرور"');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1,$2,$3,'super_admin')
     ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name
     RETURNING id, full_name, email, role`,
    [fullName, email, hash],
  );
  console.log('Admin ready:', rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
