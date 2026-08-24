import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { authRouter } from './routes/auth';
import { agreementsRouter } from './routes/agreements';
import { importsRouter } from './routes/imports';
import { sourcesRouter } from './routes/sources';
import { searchRouter } from './routes/search';
import { productsRouter } from './routes/products';
import { configuratorRouter } from './routes/configurator';
import { statsRouter } from './routes/stats';
import { synonymsRouter } from './routes/synonyms';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'agreements-catalog-backend' }));

app.use('/api/auth', authRouter);
app.use('/api/agreements', agreementsRouter);
app.use('/api/admin/import', importsRouter);
app.use('/api/admin/sources', sourcesRouter);
app.use('/api/admin/synonyms', synonymsRouter);
app.use('/api/search', searchRouter);
app.use('/api/products', productsRouter);
app.use('/api/configurator', configuratorRouter);
app.use('/api/stats', statsRouter);

// Static frontend (public search UI + admin UI) — plain HTML/CSS/JS, no build step.
app.use(express.static(path.resolve(__dirname, '../../frontend')));

// Central error handler — never leak stack traces/DB details to the client.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم' });
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${PORT}`);
});
