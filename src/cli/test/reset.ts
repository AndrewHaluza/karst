import { DatabaseSync } from 'node:sqlite';
import { readSchema, SCHEMA_VERSION } from '../../store/migrations.js';

/**
 * The `karst test reset` subcommand — drop every table and rebuild the current
 * schema from scratch, so the next test starts from a clean slate.
 *
 * This is the ONE CLI path that may migrate, and it is deliberately NOT the
 * generic `openWritableStore` path: the CLI runs under `node:sqlite`
 * (`DatabaseSync`, ABI-agnostic — it must not load the better-sqlite3 addon
 * that an Electron build ships), and `migrate()` is typed against
 * better-sqlite3's `pragma`/`transaction` surface. Dropping all tables and
 * exec'ing `schema.sql` reproduces what `migrate()` produces on a brand-new
 * registry: schema.sql IS the complete current schema, every later version's
 * columns and tables are mirrored into it, and `readSchema()` is what
 * `migrate()` itself reads for a fresh DB.
 *
 * Foreign keys are turned OFF for the drop so table order never matters (SQLite
 * would otherwise refuse to drop a parent table its children still reference),
 * and `sqlite_sequence` is cleared so AUTOINCREMENT counters restart too — a
 * truly clean slate, not just an empty one.
 *
 * Destructive by design and opt-in by construction: it only ever touches the
 * registry the caller named with `--db`, and the driver's own tests point that
 * at a scratch file.
 */
export function runReset(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      db.exec(`DROP TABLE "${name}"`);
    }
    // Dropping the last AUTOINCREMENT table makes SQLite drop `sqlite_sequence`
    // with it, so counters restart automatically — the DELETE here is only for a
    // DB whose sequence table lingered (guarded: it may not exist on a fresh file).
    const hasSequence = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
      .get();
    if (hasSequence) db.exec('DELETE FROM sqlite_sequence');
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(readSchema());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch (err) {
    db.close();
    throw err;
  }
  db.close();
  return JSON.stringify({ ok: true });
}
