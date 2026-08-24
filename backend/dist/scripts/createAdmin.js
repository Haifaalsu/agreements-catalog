"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Bootstraps the first super_admin user.
 * Usage: npm run create-admin -- "الاسم الكامل" admin@example.com "كلمة المرور"
 */
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pool_1 = require("../db/pool");
const authService_1 = require("../services/authService");
async function main() {
    const [fullName, email, password] = process.argv.slice(2);
    if (!fullName || !email || !password) {
        console.error('Usage: npm run create-admin -- "الاسم الكامل" admin@example.com "كلمة المرور"');
        process.exit(1);
    }
    const hash = await (0, authService_1.hashPassword)(password);
    const { rows } = await pool_1.pool.query(`INSERT INTO users (full_name, email, password_hash, role) VALUES ($1,$2,$3,'super_admin')
     ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name
     RETURNING id, full_name, email, role`, [fullName, email, hash]);
    console.log('Admin ready:', rows[0]);
    await pool_1.pool.end();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=createAdmin.js.map