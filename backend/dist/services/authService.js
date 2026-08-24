"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyLogin = verifyLogin;
exports.signToken = signToken;
exports.verifyToken = verifyToken;
exports.hashPassword = hashPassword;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const pool_1 = require("../db/pool");
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const TOKEN_TTL = '12h';
async function verifyLogin(email, password) {
    const { rows } = await pool_1.pool.query(`SELECT id, full_name, email, password_hash, role FROM users WHERE email = $1 AND is_active = TRUE`, [email]);
    const user = rows[0];
    if (!user || !user.password_hash)
        return null;
    const ok = await bcryptjs_1.default.compare(password, user.password_hash);
    if (!ok)
        return null;
    return { id: user.id, fullName: user.full_name, email: user.email, role: user.role };
}
function signToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
function verifyToken(token) {
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch {
        return null;
    }
}
async function hashPassword(password) {
    return bcryptjs_1.default.hash(password, 10);
}
//# sourceMappingURL=authService.js.map