"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireSuperAdmin = requireSuperAdmin;
const authService_1 = require("../services/authService");
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
    }
    const token = header.slice('Bearer '.length);
    const payload = (0, authService_1.verifyToken)(token);
    if (!payload)
        return res.status(401).json({ error: 'جلسة غير صالحة أو منتهية' });
    req.user = payload;
    next();
}
function requireSuperAdmin(req, res, next) {
    if (req.user?.role !== 'super_admin')
        return res.status(403).json({ error: 'صلاحية غير كافية' });
    next();
}
//# sourceMappingURL=auth.js.map