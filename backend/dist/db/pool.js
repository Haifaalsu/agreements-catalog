"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.withTransaction = withTransaction;
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// When CUTOVER_TO_NEON=true, connect to TARGET_DATABASE_URL (the Neon database)
// instead of DATABASE_URL (the old Render Postgres). This flag-based switch means
// the cutover never requires copying the Neon connection string (with its
// password) through any tool, log, or chat message — it stays only inside
// Render's own environment variable store, set directly in the dashboard/API.
const USE_NEON = process.env.CUTOVER_TO_NEON === 'true';
const connectionString = USE_NEON ? process.env.TARGET_DATABASE_URL : process.env.DATABASE_URL;
exports.pool = new pg_1.Pool({
    connectionString,
    max: 10,
    ssl: USE_NEON ? { rejectUnauthorized: false } : undefined,
});
exports.pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Unexpected PG pool error', err);
});
async function withTransaction(fn) {
    const client = await exports.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=pool.js.map
