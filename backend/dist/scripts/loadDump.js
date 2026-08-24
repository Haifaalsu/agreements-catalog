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
 * Loads backend/seed/full_dump.sql.gz — a full pg_dump (schema + real data,
 * using --inserts so it is plain SQL, not COPY blocks) — into whatever
 * DATABASE_URL points at, but ONLY if that database looks empty. Safe to run
 * on every deploy/restart: a populated database is left untouched.
 *
 * The dump is executed statement-by-statement (not as one giant multi-MB
 * message) because some managed Postgres connections sit behind a proxy that
 * resets the connection on an oversized single query. Large multi-row INSERT
 * statements are further re-batched into small chunks for the same reason.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const zlib_1 = __importDefault(require("zlib"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pg_1 = require("pg");
const DUMP_PATH = path_1.default.resolve(__dirname, '../../seed/full_dump.sql.gz');
const MAX_TUPLES_PER_INSERT = 50;
function splitSqlStatements(sql) {
    const statements = [];
    let start = 0;
    let i = 0;
    const n = sql.length;
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let dollarTag = null;
    while (i < n) {
        const c = sql[i];
        if (inLineComment) {
            if (c === '\n')
                inLineComment = false;
            i++;
            continue;
        }
        if (dollarTag) {
            if (sql.startsWith(dollarTag, i)) {
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            i++;
            continue;
        }
        if (inSingle) {
            if (c === "'") {
                if (sql[i + 1] === "'") {
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
                if (sql[i + 1] === '"') {
                    i += 2;
                    continue;
                }
                inDouble = false;
            }
            i++;
            continue;
        }
        if (c === '-' && sql[i + 1] === '-') {
            inLineComment = true;
            i += 2;
            continue;
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
            const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
            if (m) {
                dollarTag = m[0];
                i += dollarTag.length;
                continue;
            }
            i++;
            continue;
        }
        if (c === ';') {
            const stmt = sql.slice(start, i).trim();
            if (stmt.length > 0)
                statements.push(stmt);
            start = i + 1;
            i++;
            continue;
        }
        i++;
    }
    const tail = sql.slice(start).trim();
    if (tail.length > 0)
        statements.push(tail);
    return statements;
}
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
    console.log('[loadDump] database looks empty — loading seed dump...');
    const raw = zlib_1.default.gunzipSync(fs_1.default.readFileSync(DUMP_PATH)).toString('utf8');
    const sql = raw
        .split('\n')
        .filter((line) => !line.startsWith('\\'))
        .join('\n');
    const rawStatements = splitSqlStatements(sql);
    const statements = [];
    for (const s of rawStatements) {
        if (/^INSERT INTO/i.test(s)) {
            statements.push(...rebatchInsert(s, MAX_TUPLES_PER_INSERT));
        }
        else {
            statements.push(s);
        }
    }
    console.log(`[loadDump] executing ${statements.length} statements...`);
    await client.query('BEGIN');
    try {
        let done = 0;
        for (const stmt of statements) {
            await client.query(stmt);
            done++;
            if (done % 200 === 0)
                console.log(`[loadDump] ${done}/${statements.length}...`);
        }
        await client.query('COMMIT');
    }
    catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    }
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