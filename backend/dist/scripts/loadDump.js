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
    return new pg_1.Client({
        connectionString: process.env.DATABASE_URL,
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
