import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../store/schemaVersion.js';

/** Older registry: only the extension migrates, and only when it loads this build. */
const RELOAD_HINT =
  'Reload every IDE window that runs Karst, so that the extension loads this build ' +
  'and migrates the registry, then retry.';

/** Newer registry: a reload cannot downgrade it, so the CLI build must change. */
const UPDATE_HINT =
  'Update the CLI build to match the registry, then retry. A reload cannot downgrade a registry.';

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
        `v${SCHEMA_VERSION}. ${RELOAD_HINT}`,
    );
  }
}

/**
 * Fail closed unless the registry is EXACTLY this build's schema version.
 *
 * The graph verbs (Slice 2 Task 6) are stricter than the marker verbs: a
 * registry NEWER than this build may carry graph columns and semantics this
 * CLI does not understand, so a submission against it must be refused rather
 * than half-applied. The error names the file and both versions so the
 * invoking agent can act on it.
 */
export function assertExactSchema(db: DatabaseSync, dbPath: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version !== SCHEMA_VERSION) {
    const hint = version > SCHEMA_VERSION ? UPDATE_HINT : RELOAD_HINT;
    throw new Error(
      `karst registry at ${dbPath} is schema v${version}, but this build requires ` +
        `exactly v${SCHEMA_VERSION}. ${hint}`,
    );
  }
}
