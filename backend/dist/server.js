"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const path_1 = __importDefault(require("path"));
const auth_1 = require("./routes/auth");
const agreements_1 = require("./routes/agreements");
const imports_1 = require("./routes/imports");
const sources_1 = require("./routes/sources");
const search_1 = require("./routes/search");
const products_1 = require("./routes/products");
const configurator_1 = require("./routes/configurator");
const stats_1 = require("./routes/stats");
const synonyms_1 = require("./routes/synonyms");
// Safety net: an unhandled promise rejection in an async route handler
// (e.g. a bad-input DB error the code didn't anticipate) would otherwise
// crash the ENTIRE Node process by default (Node 15+), taking the whole
// site down for every user for the ~20s it takes Render to restart it —
// this is what was happening for any /api/products/:id or /api/agreements/:id
// request with a non-UUID id. Logging instead of exiting keeps one bad
// request from becoming a site-wide outage.
process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('Unhandled promise rejection:', reason);
});
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'agreements-catalog-backend' }));
app.use('/api/auth', auth_1.authRouter);
app.use('/api/agreements', agreements_1.agreementsRouter);
app.use('/api/admin/import', imports_1.importsRouter);
app.use('/api/admin/sources', sources_1.sourcesRouter);
app.use('/api/admin/synonyms', synonyms_1.synonymsRouter);
app.use('/api/search', search_1.searchRouter);
app.use('/api/products', products_1.productsRouter);
app.use('/api/configurator', configurator_1.configuratorRouter);
app.use('/api/stats', stats_1.statsRouter);
// Static frontend (public search UI + admin UI) — plain HTML/CSS/JS, no build step.
app.use(express_1.default.static(path_1.default.resolve(__dirname, '../../frontend')));
// Central error handler — never leak stack traces/DB details to the client.
app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم' });
});
const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on :${PORT}`);
});
//# sourceMappingURL=server.js.map
