import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../store/db.js';
import { assertMigratedSchema } from './assertMigrated.js';

export function openReadonlyStore(dbPath: string): Store {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assertMigratedSchema(db, dbPath);
  } catch (e) {
    db.close();
    throw e;
  }
  return {
    // Boundary cast: node:sqlite's DatabaseSync is structurally compatible with
    // the read surface the store helpers use, but not nominally the better-sqlite3
    // type. Confined to this CLI-only adapter. `Store['db']`'s only behavioral
    // guarantee this cast can't paper over (NDL-35, SAVEPOINT nesting) doesn't
    // apply here either way — a read-only connection never opens a transaction.
    db: db as unknown as Store['db'],
    close: () => db.close(),
  };
}
