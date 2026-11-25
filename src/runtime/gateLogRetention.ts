/**
 * Retention for the gate-log dirs of an archived ticket (`artifacts.maxAgeDays`).
 *
 * `<globalStorage>/artifacts/<ticketId>/` holds a ticket's gate and agent
 * console logs (`uat-ticket-<id>-<run>.log`, `review-…`, `agent-*`). Until now
 * only a hard delete (`deleteTicket`) or the orphan sweep of a gone ticket
 * (`artifactOrphans.ts`) removed them, so an archived ticket's logs grew
 * forever. This sweep reuses the manifest's existing `artifacts.maxAgeDays`
 * (absent = keep forever): a dir goes only when its ticket is ARCHIVED in this
 * window's project, its `archived_at` is older than the cutoff, and EVERY file
 * inside is older too — a log that is still being appended to pins the dir.
 *
 * Host-agnostic: the ticket lookup is injected as a callback, and every fs call
 * is async (`node:fs/promises`) so the extension host event loop never blocks.
 * `p<n>` T2 stores and the non-numeric capture dirs are never candidates.
 */

import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_MS = 86_400_000;

/** A ticket dir name: digits and nothing else. `p1`, `captures`, `12x` never match. */
const TICKET_DIR = /^\d+$/;

export interface PurgeArchivedGateLogsDeps {
  /**
   * Returns the ticket's `archived_at` timestamp (SQLite `datetime('now')` UTC
   * or ISO-8601), `null` when the ticket exists in this project and is not
   * archived, or `undefined` when missing or owned by another project.
   */
  archivedAt: (ticketId: number) => string | null | undefined;
  now?: () => Date;
  debug: (message: string) => void;
  /** Optional test seam for deterministic per-dir removal failures. */
  removeDir?: (path: string) => Promise<void>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Remove ONE ticket's gate-log dir. `force` makes an already-gone dir a no-op. */
export async function removeGateLogDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * `archived_at` epoch ms. `archiveTicket` writes SQLite `datetime('now')` — UTC
 * with a space and no zone — which `Date.parse` would read as LOCAL time; the
 * space form is made explicit (`T…Z`). An ISO-8601 string already carries its
 * zone and is parsed as-is.
 */
function parseArchivedMs(raw: string): number {
  return Date.parse(raw.includes(' ') ? `${raw.replace(' ', 'T')}Z` : raw);
}

/**
 * True only when the ticket is archived AND archived strictly before the
 * cutoff. A missing/other-project row (`undefined`), a live one (`null`), and
 * an unparseable timestamp all decline: retention never guesses.
 */
function isArchivedBeforeCutoff(raw: string | null | undefined, cutoff: number): boolean {
  if (!raw) return false;
  const ms = parseArchivedMs(raw);
  return Number.isFinite(ms) && ms < cutoff;
}

/**
 * True when any file under `dir` was touched at or after the cutoff. `lstat` is
 * deliberate: a nested symlink is not a directory, so it is judged by its own
 * mtime and its target is never walked. Async so the extension host never
 * blocks on a large log tree.
 */
async function hasRecentFile(dir: string, cutoff: number): Promise<boolean> {
  for (const name of await readdir(dir)) {
    const child = join(dir, name);
    const st = await lstat(child);
    if (st.isDirectory()) {
      if (await hasRecentFile(child, cutoff)) return true;
    } else if (st.mtimeMs >= cutoff) {
      return true;
    }
  }
  return false;
}

/**
 * Remove every `<artifactsRoot>/<ticketId>/` dir that belongs to a ticket
 * archived in the caller's project before the cutoff and holds no newer file.
 * A missing or unreadable root is a no-op, a per-dir failure is logged and the
 * pass continues, and the removed ticket ids are returned.
 */
export async function purgeArchivedGateLogs(
  artifactsRoot: string,
  maxAgeDays: number,
  deps: PurgeArchivedGateLogsDeps,
): Promise<number[]> {
  const cutoff = (deps.now ?? (() => new Date()))().getTime() - maxAgeDays * DAY_MS;
  const remove = deps.removeDir ?? removeGateLogDir;
  const removed: number[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(artifactsRoot, { withFileTypes: true });
  } catch (e) {
    deps.debug(`[artifacts] gate-log retention: cannot read ${artifactsRoot}: ${errorMessage(e)}`);
    return removed;
  }
  for (const entry of entries) {
    // `isDirectory()` is false for a plain file and for a symlink to a dir; the
    // name test keeps the `p<n>` T2 stores and every capture dir out of reach.
    if (!entry.isDirectory() || !TICKET_DIR.test(entry.name)) continue;
    const ticketId = Number(entry.name);
    try {
      if (!isArchivedBeforeCutoff(deps.archivedAt(ticketId), cutoff)) continue;
      const dirPath = join(artifactsRoot, entry.name);
      if (await hasRecentFile(dirPath, cutoff)) continue;
      // The walk above awaits per file. Re-read the fact it was gated on: the
      // ticket may have been unarchived or unadopted while the walk ran, and a
      // live ticket's console logs are its evidence.
      if (!isArchivedBeforeCutoff(deps.archivedAt(ticketId), cutoff)) continue;
      await remove(dirPath);
      removed.push(ticketId);
    } catch (e) {
      deps.debug(`[artifacts] gate-log retention: failed on ticket ${ticketId}: ${errorMessage(e)}`);
    }
  }
  return removed;
}
