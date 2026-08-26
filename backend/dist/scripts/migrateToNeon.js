"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateToNeon = migrateToNeon;
/**
 * One-time migration: copies the full schema + all data from the current
 * database (process.env.DATABASE_URL — the Render free Postgres this app
 * has been running on) into a new target database
 * (process.env.TARGET_DATABASE_URL — a Neon free-tier Postgres), so the app
 * can move to a faster, more generous free host without losing anything.
 *
 * Runs entirely on Render's own network (this script executes as the
 * backend service's startCommand for one deploy), which is why it can reach
 * both databases — a sandboxed dev environment without outbound Postgres
 * access cannot do this migration directly.
 *
 * Safe to re-run: schema migrations are idempotent (tracked in
 * schema_migrations), and each table copy TRUNCATEs the target table first,
 * so a retry after a partial failure never duplicates rows.
 *
 * This is a ONE-OFF script — not part of normal app startup. It's invoked by
 * temporarily setting the Render service's start command to run it instead
 * of the server, then reverted back to the normal start command once the
 * migration is confirmed successful.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pg_1 = require("pg");
const MIGRATIONS_DIR = path_1.default.resolve(__dirname, '../../migrations');
// Dependency order — parents before children, so foreign keys never fail.
const TABLES_IN_ORDER = [
    'users',
    'agreements',
    'sources',
    'products',
    'field_mappings',
    'configurator_dimensions',
    'import_batches',
    'staging_products',
    'import_issues',
    'synonym_groups',
    'synonym_terms',
    'import_logs',
];
async function applyMigrations(target) {
    await target.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
    const files = fs_1.default.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const { rows: applied } = await target.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.map((r) => r.filename));
    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`[schema] skip  ${file} (already applied)`);
            continue;
        }
        const sql = fs_1.default.readFileSync(path_1.default.join(MIGRATIONS_DIR, file), 'utf-8');
        console.log(`[schema] apply ${file} ...`);
        await target.query('BEGIN');
        try {
            await target.query(sql);
            await target.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
            await target.query('COMMIT');
            console.log('[schema]   ok');
        }
        catch (err) {
            await target.query('ROLLBACK');
            console.error(`[schema]   FAILED: ${file}`);
            throw err;
        }
    }
}
// JSONB columns (raw_data, mapped_attributes, details — always plain "{...}"
// objects per schema) come back from node-pg as parsed JS objects and must
// be re-serialized to insert them via a parameterized query. Native Postgres
// array columns (e.g. header_columns TEXT[]) ALSO come back as JS arrays,
// but must be left alone — node-pg serializes real arrays correctly on its
// own, and JSON-stringifying one produces "[...]" which Postgres rejects as
// a malformed array literal (it expects "{...}").
function toParam(v) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        return JSON.stringify(v);
    }
    return v;
}
// Tables with a self-referential FK column (points back at the same table's
// primary key) need two passes: insert every row with that column forced to
// NULL first (so no row is ever blocked waiting on a sibling that hasn't
// been inserted yet), then a follow-up UPDATE pass restores the real values
// once all rows in the table exist.
const SELF_REFERENCING_COLUMNS = {
    sources: 'superseded_by',
};
async function copyTable(source, target, table) {
    const { rows } = await source.query(`SELECT * FROM ${table}`);
    console.log(`[data] ${table}: ${rows.length} row(s) to copy`);
    await target.query(`TRUNCATE TABLE ${table} CASCADE`);
    if (rows.length === 0)
        return;
    const selfRefCol = SELF_REFERENCING_COLUMNS[table];
    const columns = Object.keys(rows[0]);
    const colList = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
    await target.query('BEGIN');
    try {
        let done = 0;
        for (const row of rows) {
            const values = columns.map((c) => {
                if (selfRefCol && c === selfRefCol)
                    return null; // pass 1: null it out
                return toParam(row[c]);
            });
            await target.query(insertSql, values);
            done++;
            if (done % 1000 === 0)
                console.log(`[data]   ${table}: ${done}/${rows.length}`);
        }
        if (selfRefCol) {
            const toRestore = rows.filter((r) => r[selfRefCol] !== null);
            console.log(`[data]   ${table}: restoring ${toRestore.length} self-referencing "${selfRefCol}" value(s)...`);
            for (const row of toRestore) {
                await target.query(`UPDATE ${table} SET "${selfRefCol}" = $1 WHERE id = $2`, [row[selfRefCol], row.id]);
            }
        }
        await target.query('COMMIT');
        console.log(`[data]   ${table}: done (${rows.length})`);
    }
    catch (err) {
        await target.query('ROLLBACK');
        console.error(`[data]   FAILED on table ${table}`);
        throw err;
    }
}
// Exported so loadDump.ts can invoke this as one step of its normal boot
// sequence (controlled by the RUN_NEON_MIGRATION env var) instead of this
// needing its own separate Render startCommand, which nothing in this
// toolchain can set on an already-existing service.
async function migrateToNeon() {
    const sourceUrl = process.env.DATABASE_URL;
    const targetUrl = process.env.TARGET_DATABASE_URL;
    if (!sourceUrl)
        throw new Error('DATABASE_URL (source) is not set');
    if (!targetUrl)
        throw new Error('TARGET_DATABASE_URL (Neon) is not set');
    const source = new pg_1.Client({ connectionString: sourceUrl });
    const target = new pg_1.Client({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });
    await source.connect();
    await target.connect();
    console.log('[migrateToNeon] Connected to both source and target databases.');
    await applyMigrations(target);
    for (const table of TABLES_IN_ORDER) {
        await copyTable(source, target, table);
    }
    await source.end();
    await target.end();
    console.log('[migrateToNeon] Migration to Neon complete. ✅');
}
//# sourceMappingURL=migrateToNeon.js.map
