"use strict";
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
                if (executed % 200 === 0)
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
async function main() {
    const client = new pg_1.Client({ connectionString: process.env.DATABASE_URL });
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
    if (!fs_1.default.existsSync(DUMP_PATH)) {
        console.log('[loadDump] no seed dump found at', DUMP_PATH, '— skipping (fresh empty DB, run migrate instead).');
        await client.end();
        return;
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
    await client.end();
}
main().catch((err) => {
    console.error('[loadDump] FAILED:', err);
    process.exit(1);
});
//# sourceMappingURL=loadDump.js.map