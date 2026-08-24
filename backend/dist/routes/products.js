"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productsRouter = void 0;
const express_1 = require("express");
const productService_1 = require("../services/productService");
const authService_1 = require("../services/authService");
exports.productsRouter = (0, express_1.Router)();
exports.productsRouter.get('/:id', async (req, res) => {
    // Optional auth: an admin token unlocks admin_only/hidden raw_data fields; anonymous users get the filtered view.
    let isAdmin = false;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        const payload = (0, authService_1.verifyToken)(header.slice('Bearer '.length));
        if (payload)
            isAdmin = true;
    }
    const detail = await (0, productService_1.getProductDetail)(req.params.id, isAdmin);
    if (!detail)
        return res.status(404).json({ error: 'غير موجود' });
    res.json(detail);
});
//# sourceMappingURL=products.js.map