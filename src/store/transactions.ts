import type { Store } from './db.js';

/**
 * Run a callback behind SQLite's write-reserving transaction boundary.
 *
 * `better-sqlite3` selects the mode on the callable returned by
 * `db.transaction(fn)`. The node:sqlite store adapters expose that same
 * contract, so callers do not need a driver-specific options argument that
 * better-sqlite3 would silently ignore.
 */
export function runImmediateTransaction<T>(db: Store['db'], fn: () => T): T {
  return db.transaction(fn).immediate();
}
