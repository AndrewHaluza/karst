import { readdirSync, rmSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { baselineReviewRoot } from './baselineRows.js';

/**
 * Retention for the baseline-review image cache (@arch:BASELINE-REVIEW).
 *
 * `<globalStorage>/baseline-review/<ticketId>/` holds the OLD and NEW image
 * copies the review overlay shows. It is a CACHE, not evidence: the loader
 * re-materializes every image from git or the worktree when it renders, and the
 * overlay exists only while a ticket is parked `blocked: baseline-review` at
 * UAT. So a folder is removable as soon as its ticket is archived or deleted —
 * otherwise a UI ticket's ~100 MB stays forever. Free of `vscode` and of the
 * store: the ticket lookup is injected as a callback.
 */

/** A ticket folder name: a positive integer and nothing else ever becomes a path. */
const TICKET_DIR = /^[1-9]\d*$/;

/** What the store says about one candidate folder. */
export type BaselineReviewCacheState = 'missing' | 'archived' | 'active';

export interface BaselineReviewCacheDeps {
  /** `missing` = no such ticket row; `active` = exists and is not archived. */
  ticketState: (ticketId: number) => BaselineReviewCacheState;
  debug: (message: string) => void;
}

/** Remove ONE ticket's cached images. Refuses anything that is not a ticket id. */
export function removeBaselineReviewDir(storageDir: string, ticketId: number): void {
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new Error(
      `karst: refusing to remove the baseline-review cache of a non-ticket id: ${String(ticketId)}`,
    );
  }
  rmSync(join(baselineReviewRoot(storageDir), String(ticketId)), { recursive: true, force: true });
}

/**
 * Remove the cached images of every ticket that is gone or archived; keep every
 * live one (any stage — a `done` ticket not yet archived can still be reopened,
 * and a `uat` one may be parked on the review itself). Only numeric folders are
 * candidates, so a stray file or a non-ticket directory is never touched. A
 * per-folder failure is logged and the pass continues. Returns the removed ids.
 */
export function sweepBaselineReviewCache(
  storageDir: string,
  deps: BaselineReviewCacheDeps,
): number[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(baselineReviewRoot(storageDir), { withFileTypes: true });
  } catch {
    // No cache root yet (or it is unreadable): nothing to sweep.
    return [];
  }
  const removed: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TICKET_DIR.test(entry.name)) continue;
    const ticketId = Number(entry.name);
    try {
      if (deps.ticketState(ticketId) === 'active') continue;
      removeBaselineReviewDir(storageDir, ticketId);
      removed.push(ticketId);
    } catch (e) {
      deps.debug(
        `karst: baseline-review cache of ticket ${entry.name} kept: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return removed;
}
