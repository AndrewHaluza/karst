import type { Store } from '../store/db.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { spawnSync } from 'node:child_process';
import { deleteTicket } from '../store/tickets.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { removeWorktree, type WorktreeRecord } from './worktree.js';
import { type ReapedServer } from './worktreeServers.js';

export interface PermanentDeleteLifecycle {
  /** Invalidate window-local UI before any late action can target the ticket. */
  closePanel(ticketId: number): void;
  /** Remove bytes after the row transaction wins against in-flight inserts. */
  reap(ticketId: number): Promise<void>;
  /** The `<globalStorage>/graph/<projectSlug>` root; when set, deleteTicket
   *  also removes the ticket's graph byte subtree after its rows (Slice 2
   *  Task 8; the activation sweep covers the absent case). */
  graphBytesRoot?: string;
  /** The `<globalStorage>/artifacts` root; when set, deleteTicket also removes
   *  the ticket's gate console-log dir after its rows (the activation sweep
   *  covers the absent case). */
  artifactsRoot?: string;
  /**
   * Frees the ticket's port allocations when its worktrees are torn down.
   * Required so a permanent delete reclaims the ports a dead ticket still holds
   * in `port_allocations`; without it the row delete would drop the allocation
   * rows but leave a leaked detached server's port invisible to the next spin.
   */
  ports: PortAllocator;
  /** Verbose decision-point logging; prefixed `[runtime]`. Absent → no lines. */
  debug?: (message: string) => void;
}

/**
 * Coordinate the store and filesystem halves of irreversible ticket deletion.
 *
 * The worktree teardown runs FIRST, before the row transaction: `removeWorktree`
 * is "the single choke point for removal" (`docs/arch/worktrees-and-servers.md`)
 * — it stops the servers running inside the tree, removes the git worktree, the
 * directory and the row, and frees the ports; this function then deletes the
 * branch. A hard delete that only dropped rows bypassed that choke point (P1-03):
 * the detached servers survived with no row any row-based sweep could see, and
 * the worktree directory + branch remained on disk under a ticket that no longer
 * existed. Doing this before the row delete also means `removeWorktree` still
 * finds the `worktrees` row it keys on.
 *
 * The row delete then stays synchronous/transactional; filesystem cleanup
 * remains async and is awaited so its failure reaches the UI instead of becoming
 * a fire-and-forget orphan with no retry handle.
 */
export async function deleteTicketPermanently(
  store: Store,
  ticketId: number,
  lifecycle: PermanentDeleteLifecycle,
): Promise<ReapedServer[]> {
  const reaped: ReapedServer[] = teardownWorktrees(store, ticketId, lifecycle);
  for (const s of reaped) {
    lifecycle.debug?.(`[runtime] permanent delete: ${s.repo} (pid ${s.pid ?? 'none'}) — ${s.outcome}`);
  }
  deleteTicket(store, ticketId, lifecycle.graphBytesRoot, lifecycle.artifactsRoot);
  // Both operations are synchronous: the DB tombstone is visible before any
  // local in-flight action can resume, then its panel is invalidated before the
  // first asynchronous yield in filesystem cleanup.
  lifecycle.closePanel(ticketId);
  await lifecycle.reap(ticketId);
  return reaped;
}

/**
 * Stop the servers under each of the ticket's worktrees, remove the worktree
 * (tree + row) and delete its branch, returning what was stopped so the caller
 * can report it.
 *
 * The branch is deleted HERE, not in `removeWorktree`: archive removes a
 * worktree precisely so its branch survives to be restored, so deleting it in
 * the choke point would break restore. A permanent delete has no such caller —
 * the ticket is gone, so the branch is dead weight that the row-only delete
 * otherwise left on disk forever.
 *
 * Best-effort per worktree: one worktree whose git removal throws must not abort
 * the permanent delete the user asked for, and the rows are still cleared by the
 * transaction below. The failure is logged through the injected `debug` seam
 * (the host binds it to the output channel), never swallowed silently.
 */
function teardownWorktrees(
  store: Store,
  ticketId: number,
  lifecycle: PermanentDeleteLifecycle,
): ReapedServer[] {
  const reaped: ReapedServer[] = [];
  for (const w of listWorktreesByTicket(store, ticketId)) {
    const record: WorktreeRecord = {
      ticketId: w.ticketId,
      repoPath: w.repo,
      slug: w.path.split(/[\\/]/).pop() ?? w.path,
      path: w.path,
      branch: w.branch ?? '',
      baseRef: w.baseRef ?? w.branch ?? '',
      depsMode: w.depsMode === 'local' ? 'local' : 'inherited',
      adopted: false,
    };
    try {
      reaped.push(...removeWorktree(store, record, lifecycle.ports));
      if (record.branch !== '') deleteBranch(w.repo, record.branch, lifecycle.debug);
    } catch (err) {
      lifecycle.debug?.(`[runtime] permanent delete: worktree ${w.path} teardown failed: ${String(err)}`);
    }
  }
  return reaped;
}

/**
 * `git branch -D <branch>` in `repoPath`. A missing branch (already deleted, or
 * never created) is normal, not an error — best-effort cleanup of a ticket that
 * is being erased anyway. The worktree is already removed by the time this runs,
 * so git accepts the delete.
 */
function deleteBranch(
  repoPath: string,
  branch: string,
  debug?: (message: string) => void,
): void {
  const r = spawnSync('git', ['branch', '-D', branch], { cwd: repoPath, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    debug?.(`[runtime] permanent delete: could not delete branch ${branch} in ${repoPath}: ${r.stderr ?? r.error?.message ?? ''}`);
  }
}
