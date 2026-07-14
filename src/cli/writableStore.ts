import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';

/**
 * Open the karst registry read-WRITE using Node's BUILT-IN `node:sqlite`
 * (sibling of `openReadonlyStore`). Rationale: the marker CLI (`karst stage …`)
 * is invoked by the agent via plain `node`, so it cannot load the extension's
 * `better-sqlite3` native addon (compiled for the Electron ABI — an ABI mismatch
 * would crash). `node:sqlite` needs no native addon, so the CLI stays
 * ABI-agnostic while still being able to advance a stage.
 *
 * The stage machine's `store.db` surface is `.prepare(sql).run/get/all(...)`
 * PLUS `.transaction(fn)` — a method `DatabaseSync` does not provide. We wrap the
 * connection so `.transaction()` mimics better-sqlite3's contract (it returns a
 * callable that runs the body inside `BEGIN`/`COMMIT`, rolling back on throw),
 * and pass `.prepare` straight through. Confined to this CLI-only adapter; the
 * schema is NOT migrated here (the extension already created the file).
 */
export function openWritableStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');

  const shim = {
    prepare: (sql: string) => db.prepare(sql),
    /**
     * better-sqlite3 parity: `transaction(fn)` returns a function; calling it
     * runs `fn` in a single transaction. Nested BEGINs are not expected (the
     * machine wraps exactly one), so we keep it flat.
     */
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => {
      return (...args: A): R => {
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      };
    },
  };

  return {
    // Boundary cast: node:sqlite's connection, wrapped with a transaction shim,
    // is structurally compatible with the write surface the machine uses, but
    // not nominally the better-sqlite3 type. Confined to this CLI-only adapter.
    db: shim as unknown as Store['db'],
    close: () => db.close(),
  };
}
