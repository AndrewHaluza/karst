import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export interface Store {
  db: Database.Database;
  close(): void;
}

const BUSY_TIMEOUT_MS = 5000;
const WAL_RETRY_SLEEP_MS = 50;
const WAL_MAX_ATTEMPTS = Math.ceil(BUSY_TIMEOUT_MS / WAL_RETRY_SLEEP_MS);

function isBusy(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: string }).code?.startsWith('SQLITE_BUSY') === true ||
      /database is locked/i.test(err.message))
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switch to WAL. Changing a rollback-journal file to WAL needs an exclusive
 * lock and SQLite may return SQLITE_BUSY at once, bypassing busy_timeout, so
 * the switch is retried here. A peer that won the race leaves the file in WAL,
 * which the journal_mode re-read at the top of each attempt accepts.
 */
function enableWal(db: Database.Database): void {
  for (let attempt = 1; ; attempt++) {
    if (db.pragma('journal_mode', { simple: true }) === 'wal') return;
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if (!isBusy(err) || attempt >= WAL_MAX_ATTEMPTS) throw err;
      sleepSync(WAL_RETRY_SLEEP_MS);
    }
  }
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
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(db);
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
