import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export interface Store {
  db: Database.Database;
  close(): void;
}

/**
 * Branding marker only `openStore`'s genuine better-sqlite3 connection may
 * carry (NDL-35). better-sqlite3's `db.transaction(fn)` auto-detects an
 * already-open transaction and nests it as a SAVEPOINT; the CLI's
 * `node:sqlite`-backed `transactionFamily` shim (`src/cli/writableStore.ts`)
 * does not — it issues a bare `BEGIN` on every call and throws
 * ("cannot start a transaction within a transaction") if one is already open.
 *
 * A mutation whose correctness depends on the SAVEPOINT behavior — today,
 * only `recordFindings` (`store/reviewFindings.ts`), which is sometimes
 * invoked from inside an outer `store.db.transaction` (`workflow/gates/
 * commit.ts`'s `recordFindingsIfAny`) — must require `NestableStore`, not the
 * plain `Store` every other helper takes. `openWritableStore`/
 * `openReadonlyStore`/`openGraphWritableStore` (`src/cli/*`) only ever return
 * a plain `Store`, so a future CLI call site that reaches such a function now
 * fails to compile instead of throwing SQLITE_ERROR the first time an agent
 * hits it.
 */
declare const NESTABLE_TRANSACTIONS: unique symbol;

export interface NestableStore extends Store {
  readonly db: Database.Database & { readonly [NESTABLE_TRANSACTIONS]: true };
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
export function openStore(path: string): NestableStore {
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
    // Boundary assertion, not a lie: better-sqlite3's `db.transaction` really
    // does nest as a SAVEPOINT, which no structural type can express — this
    // brand states the one fact that actually distinguishes this connection
    // from the CLI's. Confined to this single call site; see `NestableStore`.
    db: db as unknown as Database.Database & { readonly [NESTABLE_TRANSACTIONS]: true },
    close: () => db.close(),
  };
}
