// Standalone child-process entry point for the NDL-36 regression test
// (db.test.ts, "two windows opening a legacy DB concurrently"). Runs as a
// SEPARATE OS process — not an in-process helper — because the race it
// reproduces (two real VS Code extension hosts calling `openStore` on the
// same file at once) needs two genuinely concurrent SQLite connections;
// nothing inside one Node process can do that with better-sqlite3's
// synchronous, blocking calls.
import { openStore } from './db.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: migrationRaceWorker.ts <db-path>');
  process.exit(2);
}

try {
  const store = openStore(path);
  store.close();
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
