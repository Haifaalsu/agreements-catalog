"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authService_1 = require("../services/authService");
exports.authRouter = (0, express_1.Router)();
const loginSchema = zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(1) });
exports.authRouter.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'بيانات الدخول غير صحيحة' });
    const user = await (0, authService_1.verifyLogin)(parsed.data.email, parsed.data.password);
    if (!user)
        return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    const token = (0, authService_1.signToken)({ id: user.id, role: user.role });
    res.json({ token, user });
});
//# sourceMappingURL=auth.js.map