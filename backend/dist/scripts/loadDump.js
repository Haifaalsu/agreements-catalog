"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * One-time Staging seed loader. Runs at container startup (before the server
 * starts), NOT during the build step — Render's build environment does not
 * reliably reach the database over its internal network.
 *
 * Streams backend/seed/full_dump.sql.gz (a full pg_dump using --inserts, so
 * it is plain SQL, not COPY blocks) into whatever DATABASE_URL points at,
 * but ONLY if that database looks empty. Safe to run on every deploy/restart
 * — a populated database is left untouched.
 *
 * This deliberately never holds the full (~290MB decompressed) dump, nor the
 * full list of statements, in memory at once — Render's free-tier instance
 * has a 512MB memory ceiling. Instead it streams the gunzipped text line by
 * line, assembles one top-level SQL statement at a time (respecting quoted
 * strings and dollar-quoted function bodies so semicolons inside them don't
 * cause a false split), executes it immediately, and discards it. Large
 * multi-row INSERT statements are further re-batched into small chunks —
 * both to bound memory and because some managed Postgres connections sit
 * behind a proxy that resets the connection on an oversized single query.
 */
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const readline_1 = __importDefault(require("readline"));
const zlib_1 = __importDefault(require("zlib"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pg_1 = require("pg");
const DUMP_PATH = path_1.default.resolve(__dirname, '../../seed/full_dump.sql.gz');
const MAX_TUPLES_PER_INSERT = 50;
// Split top-level tuples in "(...), (...), ..." respecting nested parens/quotes.
function splitTuples(valuesBody) {
    const tuples = [];
    let depth = 0;
    let start = 0;
    let inSingle = false;
    for (let i = 0; i < valuesBody.length; i++) {
        const c = valuesBody[i];
        if (inSingle) {
            if (c === "'") {
                if (valuesBody[i + 1] === "'") {
                    i++;
                    continue;
                }
                inSingle = false;
            }
            continue;
        }
        if (c === "'") {
            inSingle = true;
            continue;
        }
        if (c === '(') {
            depth++;
            continue;
        }
        if (c === ')') {
            depth--;
            if (depth === 0) {
                tuples.push(valuesBody.slice(start, i + 1));
                let j = i + 1;
                while (j < valuesBody.length && /[\s,]/.test(valuesBody[j]))
                    j++;
                start = j;
                i = j - 1;
            }
            continue;
        }
    }
    return tuples;
}
function rebatchInsert(stmt, maxTuplesPerBatch) {
    const m = /^(INSERT INTO [^\s(]+(?:\s*\([^)]*\))?\s*VALUES\s*)([\s\S]*)$/i.exec(stmt);
    if (!m)
        return [stmt];
    const prefix = m[1];
    const tuples = splitTuples(m[2]);
    if (tuples.length <= maxTuplesPerBatch)
        return [stmt];
    const batches = [];
    for (let i = 0; i < tuples.length; i += maxTuplesPerBatch) {
        const chunk = tuples.slice(i, i + maxTuplesPerBatch);
        batches.push(prefix + chunk.join(', '));
    }
    return batches;
}
async function execStatement(client, stmt) {
    const trimmed = stmt.trim();
    if (!trimmed)
        return;
    if (/^INSERT INTO/i.test(trimmed)) {
        for (const batch of rebatchInsert(trimmed, MAX_TUPLES_PER_INSERT)) {
            await client.query(batch);
        }
    }
    else {
        await client.query(trimmed);
    }
}
/**
 * Streams the dump and executes one top-level statement at a time.
 * State (quote/comment/dollar-tag tracking) persists across lines.
 */
async function streamLoad(client) {
    const gunzip = zlib_1.default.createGunzip();
    fs_1.default.createReadStream(DUMP_PATH).pipe(gunzip);
    const rl = readline_1.default.createInterface({ input: gunzip, crlfDelay: Infinity });
    let buffer = '';
    let inSingle = false;
    let inDouble = false;
    let dollarTag = null;
    let executed = 0;
    const processChunk = async (chunk) => {
        let i = 0;
        let start = 0;
        const n = chunk.length;
        while (i < n) {
            const c = chunk[i];
            if (dollarTag) {
                if (chunk.startsWith(dollarTag, i)) {
                    i += dollarTag.length;
                    dollarTag = null;
                    continue;
                }
                i++;
                continue;
            }
            if (inSingle) {
                if (c === "'") {
                    if (chunk[i + 1] === "'") {
                        i += 2;
                        continue;
                    }
                    inSingle = false;
                }
                i++;
                continue;
            }
            if (inDouble) {
                if (c === '"') {
                    if (chunk[i + 1] === '"') {
                        i += 2;
                        continue;
                    }
                    inDouble = false;
                }
                i++;
                continue;
            }
            if (c === '-' && chunk[i + 1] === '-') {
                // line comment — safe to skip to end of chunk (each chunk is one line here)
                break;
            }
            if (c === "'") {
                inSingle = true;
                i++;
                continue;
            }
            if (c === '"') {
                inDouble = true;
                i++;
                continue;
            }
            if (c === '$') {
                const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(chunk.slice(i));
                if (m) {
                    dollarTag = m[0];
                    i += m[0].length;
                    continue;
                }
                i++;
                continue;
            }
            if (c === ';') {
                buffer += chunk.slice(start, i + 1);
                const stmt = buffer.slice(0, -1); // drop trailing ';'
                buffer = '';
                start = i + 1;
                await execStatement(client, stmt);
                executed++;
                if (executed % 50 === 0)
                    console.log(`[loadDump] ${executed} statements executed...`);
                i++;
                continue;
            }
            i++;
        }
        buffer += chunk.slice(start);
        buffer += '\n';
    };
    for await (const line of rl) {
        if (line.startsWith('\\'))
            continue; // psql-only meta-commands (\restrict etc.)
        await processChunk(line);
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
        await execStatement(client, tail);
        executed++;
    }
    return executed;
}
function makeClient() {
    // Same CUTOVER_TO_NEON switch as db/pool.ts — once the flag is set this
    // script's own empty-check/seed-load logic also talks to Neon instead of
    // the old Render Postgres, so nothing here still depends on the old
    // database once it's flipped (it can even disappear afterward safely).
    const useNeon = process.env.CUTOVER_TO_NEON === 'true';
    return new pg_1.Client({
        connectionString: useNeon ? process.env.TARGET_DATABASE_URL : process.env.DATABASE_URL,
        ssl: useNeon ? { rejectUnauthorized: false } : undefined,
        keepAlive: true,
        keepAliveInitialDelayMillis: 5000,
        // Client-side safety net: some managed Postgres connections silently
        // drop an idle-but-open socket (no RST/FIN reaches us), which would
        // otherwise hang an awaited query forever. Fail fast instead so we can
        // reconnect and retry (the whole load is idempotent).
        query_timeout: 30000,
        statement_timeout: 30000,
    });
}
async function attempt() {
    const client = makeClient();
    await client.connect();
    try {
        const already = await client
            .query("SELECT to_regclass('public.agreements') AS reg")
            .catch(() => ({ rows: [{ reg: null }] }));
        if (already.rows[0].reg) {
            const { rows } = await client.query('SELECT count(*)::int AS n FROM public.agreements');
            if (rows[0].n > 0) {
                console.log(`[loadDump] agreements table already has ${rows[0].n} row(s) — skipping seed load.`);
                return 'skipped';
            }
        }
        if (!fs_1.default.existsSync(DUMP_PATH)) {
            console.log('[loadDump] no seed dump found at', DUMP_PATH, '— skipping (fresh empty DB, run migrate instead).');
            return 'skipped';
        }
        console.log('[loadDump] database looks empty — streaming seed dump...');
        await client.query('BEGIN');
        let count = 0;
        try {
            count = await streamLoad(client);
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        }
        console.log(`[loadDump] executed ${count} statements.`);
        await client.query('SET search_path = public');
        const { rows } = await client.query('SELECT count(*)::int AS n FROM products');
        console.log(`[loadDump] done — products table now has ${rows[0].n} row(s).`);
        return 'done';
    }
    finally {
        await client.end().catch(() => { });
    }
}
async function main() {
    // One-off escape hatch: when set, run the Render→Neon data migration
    // instead of the normal seed-check, then return without touching
    // DATABASE_URL's target at all (server.js still boots against the OLD
    // database right after this). The actual cutover to Neon happens later,
    // as a separate env-var change (DATABASE_URL -> the Neon URL) followed by
    // another deploy with this flag removed — kept as two steps on purpose so
    // the migration can be verified before traffic ever moves.
    if (process.env.RUN_NEON_MIGRATION === 'true') {
        console.log('[loadDump] RUN_NEON_MIGRATION=true — running one-off migration to Neon...');
        // Render kills a web service's deploy ("port scan timeout") if it
        // doesn't bind a port within a few minutes. This migration can easily
        // run longer than that (thousands of product rows), so bind a trivial
        // placeholder HTTP server immediately to satisfy Render's health check,
        // then run the real migration in the background. The placeholder just
        // reports status and stays up after the migration finishes/fails so the
        // deploy stays "live" instead of being killed or restart-looping.
        let migrationDone = false;
        let migrationError = null;
        const placeholderPort = Number(process.env.PORT) || 4000;
        const placeholderServer = http_1.default.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(migrationError
                ? `Neon migration FAILED: ${String(migrationError)}\n`
                : migrationDone
                    ? 'Neon migration complete.\n'
                    : 'Neon migration running...\n');
        });
        await new Promise((resolve) => placeholderServer.listen(placeholderPort, resolve));
        console.log(`[loadDump] placeholder server listening on :${placeholderPort} (keeps Render's port check happy during migration)`);
        const { migrateToNeon } = await Promise.resolve().then(() => __importStar(require('./migrateToNeon')));
        try {
            await migrateToNeon();
            migrationDone = true;
            console.log('[loadDump] Neon migration finished successfully. ✅ (placeholder server stays up — trigger a normal deploy to cut over)');
        }
        catch (err) {
            migrationError = err;
            console.error('[loadDump] Neon migration FAILED:', err);
        }
        return;
    }
    // One-off escape hatch: audit (and optionally delete) the "dead" product
    // rows left behind by the import pipeline's replace flow. Replacing a
    // source only ever marks the OLD sources row status='replaced' — it never
    // deletes that source's products rows — so every re-upload of the same
    // Excel sheet over the project's history left its previous rows behind
    // permanently. 'archived' sources (e.g. deliberately-retired old data,
    // hidden from users via is_visible_to_users rather than by deletion) are
    // a separate, intentional state and are left untouched here — only
    // status='replaced' is dead weight with no remaining purpose.
    //
    // Two flags on purpose, same pattern as the Neon migration: set only
    // RUN_PRODUCT_CLEANUP=true first to get a row-count report in the logs
    // with nothing deleted, then also set RUN_PRODUCT_CLEANUP_CONFIRM=true and
    // redeploy to actually run the DELETE, once the reported counts have been
    // reviewed.
    if (process.env.RUN_PRODUCT_CLEANUP === 'true') {
        console.log('[loadDump] RUN_PRODUCT_CLEANUP=true — auditing product rows by source status...');
        const client = makeClient();
        await client.connect();
        try {
            const { rows: byStatus } = await client.query(`
        SELECT s.status,
               count(DISTINCT s.id)::int AS source_count,
               count(p.id)::int AS product_count
        FROM sources s
        LEFT JOIN products p ON p.source_id = s.id
        GROUP BY s.status
        ORDER BY s.status
      `);
            console.log('[cleanup] product rows by source status:', JSON.stringify(byStatus));
            const confirm = process.env.RUN_PRODUCT_CLEANUP_CONFIRM === 'true';
            if (!confirm) {
                console.log('[cleanup] DRY RUN ONLY — nothing deleted. Review the counts above, then set ' +
                    'RUN_PRODUCT_CLEANUP_CONFIRM=true and redeploy to delete rows under replaced sources.');
            }
            else {
                const result = await client.query(`DELETE FROM products WHERE source_id IN (SELECT id FROM sources WHERE status = 'replaced')`);
                console.log(`[cleanup] deleted ${result.rowCount} product row(s) belonging to replaced sources. ✅`);
            }
        }
        finally {
            await client.end().catch(() => { });
        }
        return;
    }
    // One-off escape hatch: read-only capacity report — total DB size plus
    // active product-row counts per agreement. Used to decide, before any
    // import, whether the free-tier storage quota has room for new agreements
    // (and how much a removed agreement would actually free up). Makes no
    // changes of any kind.
    if (process.env.RUN_CAPACITY_CHECK === 'true') {
        console.log('[loadDump] RUN_CAPACITY_CHECK=true — reporting DB size and per-agreement row counts...');
        const client = makeClient();
        await client.connect();
        try {
            const { rows: dbSize } = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty, pg_database_size(current_database()) AS bytes`);
            console.log(`[capacity] database size: ${dbSize[0].pretty} (${dbSize[0].bytes} bytes)`);
            const { rows: perAgreement } = await client.query(`
        SELECT a.name_ar, a.slug, a.status AS agreement_status, count(p.id)::int AS active_products
        FROM agreements a
        LEFT JOIN sources s ON s.agreement_id = a.id AND s.status = 'active'
        LEFT JOIN products p ON p.source_id = s.id
        GROUP BY a.name_ar, a.slug, a.status
        ORDER BY active_products DESC
      `);
            console.log('[capacity] active product rows per agreement:', JSON.stringify(perAgreement));
            const { rows: totalRow } = await client.query(`SELECT count(*)::int AS n FROM products`);
            console.log(`[capacity] total product rows (all statuses, incl. replaced): ${totalRow[0].n}`);
            console.log('[capacity] done. ✅');
        }
        finally {
            await client.end().catch(() => { });
        }
        return;
    }
    // One-off escape hatch: report current database/table/index sizes, and
    // reclaim disk space via VACUUM FULL. Non-destructive — VACUUM never
    // removes live rows, it only physically compacts pages that DELETE/UPDATE
    // already marked reusable (e.g. the 6,574-row RUN_PRODUCT_CLEANUP delete
    // left that space "free but still allocated" until a real VACUUM FULL
    // runs). Useful when a free-tier storage quota (e.g. Neon's 0.5 GB) is
    // close to full. Reports sizes before AND after so the effect is visible
    // in the logs without needing a separate confirm step.
    if (process.env.RUN_DB_MAINTENANCE === 'true') {
        console.log('[loadDump] RUN_DB_MAINTENANCE=true — reporting sizes and running VACUUM FULL...');
        const client = makeClient();
        await client.connect();
        try {
            const { rows: dbSizeBefore } = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
            console.log(`[maintenance] database size BEFORE: ${dbSizeBefore[0].size}`);
            const { rows: relSizesBefore } = await client.query(`
        SELECT relname,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
               pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
               (SELECT count(*) FROM pg_stat_user_tables t WHERE t.relname = c.relname AND t.n_dead_tup > 0) AS has_dead_tuples
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 15
      `);
            console.log('[maintenance] largest tables (with indexes+toast) BEFORE:', JSON.stringify(relSizesBefore));
            const { rows: deadTuples } = await client.query(`
        SELECT relname, n_dead_tup, n_live_tup
        FROM pg_stat_user_tables
        WHERE n_dead_tup > 0
        ORDER BY n_dead_tup DESC
      `);
            console.log('[maintenance] dead tuple counts:', JSON.stringify(deadTuples));
            // VACUUM FULL requires no surrounding transaction; run one statement
            // at a time, and don't let one table's failure block the others.
            for (const row of relSizesBefore) {
                try {
                    console.log(`[maintenance] VACUUM (FULL, ANALYZE) ${row.relname} ...`);
                    await client.query(`VACUUM (FULL, ANALYZE) "${row.relname}"`);
                }
                catch (err) {
                    console.error(`[maintenance]   failed on ${row.relname}:`, err);
                }
            }
            const { rows: dbSizeAfter } = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
            console.log(`[maintenance] database size AFTER: ${dbSizeAfter[0].size}`);
            const { rows: relSizesAfter } = await client.query(`
        SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 15
      `);
            console.log('[maintenance] largest tables AFTER:', JSON.stringify(relSizesAfter));
            console.log('[maintenance] done. ✅');
        }
        finally {
            await client.end().catch(() => { });
        }
        return;
    }
    const MAX_ATTEMPTS = 3;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
        try {
            await attempt();
            return;
        }
        catch (err) {
            console.error(`[loadDump] attempt ${n}/${MAX_ATTEMPTS} failed:`, err);
            if (n === MAX_ATTEMPTS)
                throw err;
            console.log('[loadDump] retrying from scratch (load is idempotent — a fresh empty DB is safe to redo)...');
        }
    }
}
main().catch((err) => {
    console.error('[loadDump] FAILED:', err);
    process.exit(1);
});
//# sourceMappingURL=loadDump.js.map
