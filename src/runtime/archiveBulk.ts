import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { archiveWorktree, compactWorktree, sweepOrphanRefs, type ArchiveDeps, type ArchiveTarget } from './archive.js';
import {
  listArchivableWorktrees,
  listCompactableArchives,
  type ArchivableWorktreesOptions,
} from '../store/worktreeArchives.js';
import type { ReapedServer } from './worktreeServers.js';

export interface BulkSummary {
  archived: number;
  /** Rows whose folder was already gone; the row was deleted. */
  cleared: number;
  skipped: number;
  failed: number;
  /**
   * Every server the sweep had to deal with to remove a worktree, carried out
   * verbatim so the caller can report each one. A bulk archive is the least
   * attended path there is — it removes many worktrees at once, unprompted —
   * so it is the last place a killed (or unkillable) dev server may go unsaid.
   */
  reapedServers: ReapedServer[];
}

/**
 * Scope for the destructive bulk archive. `projectId` is REQUIRED — this sweep
 * removes worktree folders, and the store query falls back to ALL projects when
 * no `project_id` is given, so an unbound call would reap every other IDE
 * window's worktrees. Callers that cannot bind a project must refuse instead.
 */
export interface ArchiveInactiveOptions {
  projectId: number;
  /** See `ArchivableWorktreesOptions.onlyArchived`. */
  onlyArchived?: boolean;
  /** Artifact final sweep, awaited per worktree before it is archived. */
  beforeRemove?: (target: ArchiveTarget) => Promise<void>;
  /** See `ArchivableWorktreesOptions.isSessionLive`. */
  isSessionLive?: (ticketId: number) => boolean;
  /** Where each skip and failure is reported (ticket, path, reason). */
  log?: { info(m: string): void; warn(m: string): void };
  /** Seams for the stale-lock check (tests). */
  archiveDeps?: ArchiveDeps;
}

/**
 * Last reason each path failed or was skipped for, kept across ticks: the same
 * reason is logged once, and the artifact final sweep is not re-run for an item
 * that already failed (the next attempt would repeat it every minute).
 */
const lastReason = new Map<string, string>();
/** Paths that threw last tick and sit this tick out. */
const failedMemory = new Set<string>();

/** Test hook: forget what earlier ticks saw. */
export function resetArchiveSweepMemory(): void {
  lastReason.clear();
  failedMemory.clear();
}

/**
 * Archive every inactive worktree (ticket archived or done, agent not running),
 * deduped by folder path so repository entries sharing a repoPath archive once.
 * Sequential and fault-isolated: one item's failure never aborts the rest.
 *
 * Scoped by project — the DB is shared across IDE windows, so this destructive
 * sweep refuses an unbound scope rather than degrading to all-projects.
 */
export async function archiveInactiveWorktrees(
  runner: GitRunner,
  store: Store,
  allocator: PortAllocator,
  options: ArchiveInactiveOptions,
): Promise<BulkSummary> {
  if (!Number.isFinite(options.projectId)) {
    throw new Error(
      'archiveInactiveWorktrees: refusing an unscoped sweep — bind a project first',
    );
  }
  const candidates = listArchivableWorktrees(store, options satisfies ArchivableWorktreesOptions);
  const seen = new Set<string>();
  const summary: BulkSummary = {
    archived: 0,
    cleared: 0,
    skipped: 0,
    failed: 0,
    reapedServers: [],
  };

  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const report = (level: 'info' | 'warn', reason: string): void => {
      if (lastReason.get(c.path) === reason) return;
      lastReason.set(c.path, reason);
      options.log?.[level](`karst: archive sweep T${c.ticketId} ${c.path}: ${reason}`);
    };
    // Failed last tick: do not repeat the artifact final sweep (and the failing
    // step) now. Archiving WITHOUT the sweep would drop the capture, so the item
    // waits this tick and is retried in full on the next one.
    if (failedMemory.has(c.path)) {
      failedMemory.delete(c.path);
      summary.skipped += 1;
      continue;
    }
    try {
      const r = await archiveWorktree(
        runner,
        store,
        allocator,
        c,
        options.beforeRemove,
        options.archiveDeps,
      );
      summary.reapedServers.push(...r.reapedServers);
      if (r.outcome === 'archived') {
        summary.archived += 1;
        lastReason.delete(c.path);
      } else if (r.outcome === 'cleared') {
        summary.cleared += 1;
        lastReason.delete(c.path);
        options.log?.info(`karst: archive sweep T${c.ticketId} ${c.path}: ${r.reason}, row removed`);
      } else {
        summary.skipped += 1;
        report('info', r.reason ?? 'skipped');
      }
    } catch (e) {
      summary.failed += 1;
      failedMemory.add(c.path);
      report('warn', e instanceof Error ? e.message : String(e));
    }
  }
  return summary;
}

export interface CompactSummary {
  compacted: number;
  skipped: number;
  failed: number;
  sweep: { prunedBranches: number; prunedArchiveRefs: number };
}

/**
 * Compact every archived worktree whose `git-ref` archive is older than
 * `olderThanMs`, then sweep orphan branches and refs. Sequential and
 * fault-isolated like `archiveInactiveWorktrees`.
 */
export async function compactArchivedWorktrees(
  runner: GitRunner,
  store: Store,
  olderThanMs: number,
): Promise<CompactSummary> {
  const candidates = listCompactableArchives(store, olderThanMs);
  const summary: CompactSummary = { compacted: 0, skipped: 0, failed: 0, sweep: { prunedBranches: 0, prunedArchiveRefs: 0 } };

  for (const c of candidates) {
    try {
      const r = await compactWorktree(runner, store, c);
      if (r.outcome === 'compacted') summary.compacted += 1;
      else summary.skipped += 1;
    } catch {
      summary.failed += 1;
    }
  }

  try {
    summary.sweep = await sweepOrphanRefs(runner, store);
  } catch {
    // sweep failure is non-fatal — orphans are harmless leftovers
  }

  return summary;
}
