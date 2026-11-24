import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import { listPlanningSessions } from '../../store/planningSessions.js';
import { planningArtifactsDir } from '../../planning/preamble.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A direct child directory of an archived session's `artifacts/` larger than
 * this is planning scratch, not a plan: a spike that cloned repositories and
 * ran installs (P71 held 5.66 GB in one `spike/`) is removed on the retention
 * sweep. Plan files are top-level files and are never touched.
 */
export const PLANNING_ARCHIVED_DIR_MAX_BYTES = 50 * 1024 * 1024;

export interface PrunedPlanningDir {
  sessionId: number;
  dir: string;
  bytes: number;
}

export interface PrunePlanningScratchInput {
  store: Store;
  projectId: number;
  scratchRoot: string;
  afterDays: number;
  now?: Date;
  isLive: (sessionId: number) => boolean;
  debug: (message: string) => void;
  /** Optional test seam for simulating per-dir removal errors deterministically. */
  removeDir?: (path: string) => void;
}

/** SQLite `datetime('now')` text (UTC, no zone) to epoch ms. */
function sqliteMs(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

/**
 * Total bytes under `dir`. `lstat` is deliberate: a nested symlink is not a
 * directory, so it contributes only its own link size and its target is never
 * walked.
 */
function dirBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    const st = lstatSync(child);
    if (st.isDirectory()) total += dirBytes(child);
    else total += st.size;
  }
  return total;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Remove one scratch directory. `force` makes a directory that vanished between
 * the size walk and this call a no-op instead of an error.
 */
export function removeScratchDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Remove large top-level DIRECTORY entries under archived planning sessions'
 * `artifacts/` dirs. Only `archived` sessions past `afterDays` are eligible and
 * never one with a live terminal. Two things stay on purpose: every top-level
 * FILE (plans, pages, screenshots) and everything outside `artifacts/`
 * (`outbox/`, `proposals.json`, `karst-instructions.md`), because an archived
 * row still offers `Open artifacts` and `Unarchive`. Per-dir failures are
 * logged and never stop the pass.
 */
export function prunePlanningScratch(input: PrunePlanningScratchInput): PrunedPlanningDir[] {
  const cutoff = (input.now ?? new Date()).getTime() - input.afterDays * DAY_MS;
  const pruned: PrunedPlanningDir[] = [];
  const remove = input.removeDir ?? removeScratchDir;
  for (const s of listPlanningSessions(input.store, input.projectId, { includeArchived: true })) {
    if (s.status !== 'archived') continue;
    if (input.isLive(s.id)) continue;
    const updatedMs = sqliteMs(s.updatedAt);
    if (Number.isNaN(updatedMs) || updatedMs > cutoff) continue;
    const artifactsDir = planningArtifactsDir(join(input.scratchRoot, String(s.id)));
    let names: string[];
    try {
      names = readdirSync(artifactsDir);
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') {
        input.debug(`[planning] scratch retention: failed to read ${artifactsDir}: ${errorMessage(e)}`);
      }
      continue;
    }
    for (const name of names) {
      try {
        const entryPath = join(artifactsDir, name);
        const st = lstatSync(entryPath);
        // `lstat` never reports a symlink as a directory, so this skips both
        // top-level files and symlinked dirs without following the link.
        if (!st.isDirectory()) continue;
        const bytes = dirBytes(entryPath);
        if (bytes <= PLANNING_ARCHIVED_DIR_MAX_BYTES) continue;
        remove(entryPath);
        pruned.push({ sessionId: s.id, dir: name, bytes });
        input.debug(`[planning] scratch retention: removed ${name} from session ${s.id} (${bytes} B)`);
      } catch (e) {
        input.debug(
          `[planning] scratch retention: failed on session ${s.id} dir ${name}: ${errorMessage(e)}`,
        );
      }
    }
  }
  return pruned;
}
