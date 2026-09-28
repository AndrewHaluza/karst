import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';
import { assertExactSchema, assertMigratedSchema } from './assertMigrated.js';

type BeginMode = 'BEGIN' | 'BEGIN IMMEDIATE' | 'BEGIN EXCLUSIVE';

/** Bounded busy timeout for marker-verb writes (`karst stage ... pass/phase`, `env set`). */
export const MARKER_BUSY_TIMEOUT_MS = 5000;

/** node:sqlite implementation of better-sqlite3's transaction-family API. */
function transactionFamily<A extends unknown[], R>(
  db: DatabaseSync,
  fn: (...args: A) => R,
  defaultMode: BeginMode,
): ((...args: A) => R) & {
  default: (...args: A) => R;
  deferred: (...args: A) => R;
  immediate: (...args: A) => R;
  exclusive: (...args: A) => R;
} {
  const runner = (mode: BeginMode) => (...args: A): R => {
    db.exec(mode);
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return Object.assign(runner(defaultMode), {
    default: runner(defaultMode),
    deferred: runner('BEGIN'),
    immediate: runner('BEGIN IMMEDIATE'),
    exclusive: runner('BEGIN EXCLUSIVE'),
  });
}

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
  // Writable, but still NOT a migrator — only the extension migrates. Refuse a
  // stale file loudly rather than writing a stage marker through queries that
  // may reference columns this build renamed.
  try {
    assertMigratedSchema(db, dbPath);
  } catch (e) {
    db.close();
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
  // node:sqlite defaults busy_timeout to 0ms (vs. better-sqlite3's 5s default
  // in the extension host), so a marker write here would previously fail
  // immediately with SQLITE_BUSY whenever an extension window held the write
  // lock, instead of waiting like the extension's own writes do.
  db.exec(`PRAGMA busy_timeout = ${MARKER_BUSY_TIMEOUT_MS}`);

  const shim = {
    prepare: (sql: string) => db.prepare(sql),
    /**
     * better-sqlite3 parity: `transaction(fn)` returns a function; calling it
     * runs `fn` in a single transaction. Nested BEGINs are not expected (the
     * machine wraps exactly one), so we keep it flat.
     */
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) =>
      transactionFamily(db, fn, 'BEGIN'),
  };

  return {
    // Boundary cast: node:sqlite's connection, wrapped with a transaction shim,
    // is structurally compatible with the write surface the machine uses, but
    // not nominally the better-sqlite3 type. Confined to this CLI-only adapter.
    db: shim as unknown as Store['db'],
    close: () => db.close(),
  };
}

/** Bounded busy timeout for graph-verb transactions (Slice 2 Task 6). */
export const GRAPH_BUSY_TIMEOUT_MS = 5000;

/**
 * Open the registry for the GRAPH verbs (`karst graph submit`), which have
 * stricter store requirements than the marker verbs:
 *
 * - the schema must be EXACTLY this build's version — a newer registry may
 *   carry graph semantics this CLI cannot see, so it fails closed naming the
 *   file and both versions (`assertExactSchema`), never falling back to an
 *   unscoped or half-understood write;
 * - the transaction shim issues `BEGIN IMMEDIATE` plus a bounded busy
 *   timeout, so a concurrent completion in another window surfaces as a
 *   retry (`SQLITE_BUSY` after the timeout) rather than an unhandled lock
 *   error inside a plain `BEGIN`.
 */
export function openGraphWritableStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath);
  try {
    assertExactSchema(db, dbPath);
  } catch (e) {
    db.close();
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${GRAPH_BUSY_TIMEOUT_MS}`);

  const shim = {
    prepare: (sql: string) => db.prepare(sql),
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) =>
      transactionFamily(db, fn, 'BEGIN IMMEDIATE'),
  };

  return {
    db: shim as unknown as Store['db'],
    close: () => db.close(),
  };
}
