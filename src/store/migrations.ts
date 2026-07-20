import type { Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Bump when the schema changes; drives forward migrations. */
export const SCHEMA_VERSION = 6;

/** v2 onboarding columns added to `tickets`; mirror schema.sql for fresh DBs. */
const V2_TICKET_COLUMNS = [
  'description',
  'brief',
  'source_ref',
  'source_fetched_at',
  'approach',
  'selected_repos',
] as const;

/**
 * Bring a freshly opened DB up to SCHEMA_VERSION.
 *
 * v1 is idempotent (schema.sql uses CREATE TABLE IF NOT EXISTS), so re-running on
 * an existing DB never wipes data. Later versions append numbered steps here,
 * gated on the DB's current `user_version`.
 *
 * v2 adds onboarding columns to `tickets`. A fresh DB already has them (schema.sql
 * carries them); the ALTERs below only run for a legacy v1 DB being upgraded, and
 * each is guarded against the "already present" case so the step is idempotent.
 */
/** Current column names on the `tickets` table (for idempotent ALTER guards). */
function ticketColumns(db: Database): Set<string> {
  return new Set(
    db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name),
  );
}

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current < 1) {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);
  }

  if (current < 2) {
    const existing = ticketColumns(db);
    for (const col of V2_TICKET_COLUMNS) {
      if (!existing.has(col)) {
        db.exec(`ALTER TABLE tickets ADD COLUMN ${col} TEXT`);
      }
    }
  }

  if (current < 3) {
    // v3 adds the soft-delete column. Fresh DBs already carry it (schema.sql);
    // guard so the ALTER only runs for a legacy DB being upgraded.
    if (!ticketColumns(db).has('archived_at')) {
      db.exec('ALTER TABLE tickets ADD COLUMN archived_at TEXT');
    }
  }

  if (current < 4) {
    // v4 adds the single-subagent selection column. Fresh DBs already carry
    // it (schema.sql); guard so the ALTER only runs for a legacy DB being
    // upgraded.
    if (!ticketColumns(db).has('agent')) {
      db.exec('ALTER TABLE tickets ADD COLUMN agent TEXT');
    }
  }

  if (current < 5) {
    // v5 adds the per-ticket model column. Fresh DBs already carry it
    // (schema.sql); guard so the ALTER only runs for a legacy DB being upgraded.
    if (!ticketColumns(db).has('model')) {
      db.exec('ALTER TABLE tickets ADD COLUMN model TEXT');
    }
  }

  if (current < 6) {
    // v6 adds project scoping. The `projects` table is created with IF NOT
    // EXISTS so it is a no-op on a fresh DB (schema.sql already made it), and
    // the ALTER is guarded the same way as every earlier column step.
    //
    // Existing tickets keep `project_id IS NULL`. They are NOT backfilled here —
    // a migration cannot know which project they belong to. The host adopts them
    // on first bind (see `adoptUnassignedTickets`), which is correct while only
    // one project exists and is the point at which a project id is known.
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id            INTEGER PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        name          TEXT,
        root_path     TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    if (!ticketColumns(db).has('project_id')) {
      db.exec('ALTER TABLE tickets ADD COLUMN project_id INTEGER');
    }
    // Scoped list queries all filter on project_id; without this every sidebar
    // refresh is a full table scan once several projects share the DB.
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id)');
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
