/**
 * One-time Staging seed loader. Runs as part of the Render build step.
 *
 * Loads backend/seed/full_dump.sql.gz — a full pg_dump (schema + real data,
 * using --inserts so it is plain SQL, not COPY blocks, and therefore safe
 * to execute through node-postgres's simple query protocol) — into
 * whatever DATABASE_URL points at, but ONLY if that database looks empty.
 * Safe to run on every deploy: a populated database is left untouched.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import dotenv from 'dotenv';
dotenv.config();
import { Client } from 'pg';

const DUMP_PATH = path.resolve(__dirname, '../../seed/full_dump.sql.gz');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const already = await client
    .query("SELECT to_regclass('public.agreements') AS reg")
    .catch(() => ({ rows: [{ reg: null }] }));
  if (already.rows[0].reg) {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM public.agreements');
    if (rows[0].n > 0) {
      console.log(`[loadDump] agreements table already has ${rows[0].n} row(s) — skipping seed load.`);
      await client.end();
      return;
    }
  }

  if (!fs.existsSync(DUMP_PATH)) {
    console.log('[loadDump] no seed dump found at', DUMP_PATH, '— skipping (fresh empty DB, run migrate instead).');
    await client.end();
    return;
  }

  console.log('[loadDump] database looks empty — loading seed dump...');
  const raw = zlib.gunzipSync(fs.readFileSync(DUMP_PATH)).toString('utf8');
  // Strip psql-only meta-commands (\restrict / \unrestrict) that pg_dump 16+
  // emits — these are not valid SQL and node-postgres cannot execute them.
  const sql = raw
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');

  await client.query(sql);
  // The dump sets search_path to '' and never restores it — reset explicitly
  // before running our own follow-up query with an unqualified table name.
  await client.query('SET search_path = public');
  const { rows } = await client.query('SELECT count(*)::int AS n FROM products');
  console.log(`[loadDump] done — products table now has ${rows[0].n} row(s).`);
  await client.end();
}

main().catch((err) => {
  console.error('[loadDump] FAILED:', err);
  process.exit(1);
});
