"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Minimal, transparent SQL migration runner.
 * Applies every *.sql file in /migrations in filename order, tracked in
 * schema_migrations so re-running is a no-op for already-applied files.
 *
 * Usage: npm run migrate
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const pg_1 = require("pg");
const MIGRATIONS_DIR = path_1.default.resolve(__dirname, '../../migrations');
async function main() {
    const client = new pg_1.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    // Bootstrap tracking table if this is a brand new database.
    await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
    const files = fs_1.default
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    const { rows: applied } = await client.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.map((r) => r.filename));
    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`skip  ${file} (already applied)`);
            continue;
        }
        const sql = fs_1.default.readFileSync(path_1.default.join(MIGRATIONS_DIR, file), 'utf-8');
        console.log(`apply ${file} ...`);
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`  ok`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            console.error(`  FAILED: ${file}`);
            throw err;
        }
    }
    await client.end();
    console.log('Migrations complete.');
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map