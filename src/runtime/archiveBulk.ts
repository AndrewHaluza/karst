import type { Store } from '../store/db.js';
import type { GitRunner } from '../integrations/git.js';
import type { PortAllocator } from '../resolver/allocator.js';
import type { ProjectScope } from '../store/tickets.js';
import { archiveWorktree } from './archive.js';
import { listArchivableWorktrees } from '../store/worktreeArchives.js';

export interface BulkSummary {
  archived: number;
  skipped: number;
  failed: number;
}

/**
 * Archive every inactive worktree (ticket archived or done, agent not running),
 * deduped by folder path so repository entries sharing a repoPath archive once.
 * Sequential and fault-isolated: one item's failure never aborts the rest.
 *
 * Scoped by project (default: unscoped/all-projects) — the DB is shared across
 * IDE windows, so a caller with a current project MUST pass it or this reaps
 * other windows' worktrees too.
 */
export async function archiveInactiveWorktrees(
  runner: GitRunner,
  store: Store,
  allocator: PortAllocator,
  scope: ProjectScope = {},
): Promise<BulkSummary> {
  const candidates = listArchivableWorktrees(store, scope);
  const seen = new Set<string>();
  const summary: BulkSummary = { archived: 0, skipped: 0, failed: 0 };

  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    try {
      const r = await archiveWorktree(runner, store, allocator, c);
      if (r.outcome === 'archived') summary.archived += 1;
      else summary.skipped += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
