import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../store/migrations.js';

/**
 * Fail with an actionable message when the registry predates this CLI build.
 *
 * Neither CLI store migrates — only the extension does. Without this check a
 * stale file surfaces as a raw `no such column: repo` from whichever query runs
 * first, which tells the invoking agent nothing about how to fix it. Schema v10
 * renamed `service` to `repo` on three tables, so this is reachable in practice.
 */
export function assertMigratedSchema(db: DatabaseSync, dbPath: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version < SCHEMA_VERSION) {
    throw new Error(
      `karst registry at ${dbPath} is schema v${version}, but this build needs ` +
        `v${SCHEMA_VERSION}. Open the Karst extension once to migrate it, then retry.`,
    );
  }
}
