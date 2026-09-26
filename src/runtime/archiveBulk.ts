import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { archiveWorktree, compactWorktree, sweepOrphanRefs } from './archive.js';
import {
  listArchivableWorktrees,
  listCompactableArchives,
  type ArchivableWorktreesOptions,
} from '../store/worktreeArchives.js';
import type { ReapedServer } from './worktreeServers.js';

export interface BulkSummary {
  archived: number;
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
  const summary: BulkSummary = { archived: 0, skipped: 0, failed: 0, reapedServers: [] };

  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    try {
      const r = await archiveWorktree(runner, store, allocator, c);
      summary.reapedServers.push(...r.reapedServers);
      if (r.outcome === 'archived') summary.archived += 1;
      else summary.skipped += 1;
    } catch {
      summary.failed += 1;
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
