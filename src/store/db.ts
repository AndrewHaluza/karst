import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export interface Store {
  db: Database.Database;
  close(): void;
}

/**
 * Open (or create) the reference registry (§6).
 *
 * WAL mode gives atomic transitions and crash-safety while staying a single
 * portable file. Foreign-key enforcement is on. The schema is applied via an
 * idempotent migration, so reopening an existing DB preserves its data.
 *
 * Pass ':memory:' for an ephemeral store (tests). In-memory DBs can't use WAL —
 * SQLite keeps them in 'memory' journal mode, which is fine.
 */
export function openStore(path: string): Store {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  } catch (err) {
    // Don't leak the native handle if setup/migration throws.
    db.close();
    throw err;
  }

  return {
    db,
    close: () => db.close(),
  };
}
