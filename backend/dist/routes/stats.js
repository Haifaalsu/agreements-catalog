"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statsRouter = void 0;
const express_1 = require("express");
const productService_1 = require("../services/productService");
exports.statsRouter = (0, express_1.Router)();
exports.statsRouter.get('/', async (_req, res) => {
    res.json(await (0, productService_1.getStatsSummary)());
});
//# sourceMappingURL=stats.js.map