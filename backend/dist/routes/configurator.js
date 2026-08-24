"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configuratorRouter = void 0;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const configuratorService_1 = require("../services/configuratorService");
exports.configuratorRouter = (0, express_1.Router)();
async function resolveAgreementId(slugOrId) {
    const { rows } = await pool_1.pool.query(`SELECT id FROM agreements WHERE id::text = $1 OR slug = $1`, [slugOrId]);
    return rows[0]?.id ?? null;
}
exports.configuratorRouter.get('/:agreement/dimensions', async (req, res) => {
    const agreementId = await resolveAgreementId(req.params.agreement);
    if (!agreementId)
        return res.status(404).json({ error: 'الاتفاقية غير موجودة' });
    res.json(await (0, configuratorService_1.getConfiguratorDimensions)(agreementId));
});
exports.configuratorRouter.get('/:agreement/step', async (req, res) => {
    const agreementId = await resolveAgreementId(req.params.agreement);
    if (!agreementId)
        return res.status(404).json({ error: 'الاتفاقية غير موجودة' });
    let selections = {};
    if (typeof req.query.selections === 'string' && req.query.selections.length > 0) {
        try {
            selections = JSON.parse(req.query.selections);
        }
        catch {
            return res.status(400).json({ error: 'صيغة selections غير صحيحة (يجب أن تكون JSON)' });
        }
    }
    const result = await (0, configuratorService_1.resolveConfiguratorStep)(agreementId, selections);
    res.json(result);
});
//# sourceMappingURL=configurator.js.map