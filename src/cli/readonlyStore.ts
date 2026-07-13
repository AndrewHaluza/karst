import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';

/**
 * Open the karst registry read-only using Node's BUILT-IN `node:sqlite`
 * (§ context loader, A5). Rationale: the extension's `better-sqlite3` is a
 * native addon compiled for the Electron ABI, but this CLI is invoked by the
 * agent via plain `node` — loading that addon would crash on an ABI mismatch.
 * `node:sqlite` needs no native addon, so the CLI stays ABI-agnostic.
 *
 * The store read helpers (`getTicketByKey`, `listWorktreesByTicket`, …) only
 * use `store.db.prepare(sql).get/all(...positional)`, which `node:sqlite`'s
 * `StatementSync` supports with the same shape — so we expose the connection
 * behind the `Store` type via a boundary cast. Read-only: no migrations run
 * (the extension already migrated the file); writes would throw.
 */
export function openReadonlyStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    // Boundary cast: node:sqlite's DatabaseSync is structurally compatible with
    // the read surface the store helpers use, but not nominally the better-sqlite3
    // type. Confined to this CLI-only adapter.
    db: db as unknown as Store['db'],
    close: () => db.close(),
  };
}
