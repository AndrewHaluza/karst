import type { Store } from '../store/db.js';
import type { PortAllocator } from '../resolver/allocator.js';
import { deleteTicket } from '../store/tickets.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { removeWorktree } from './worktree.js';
import type { ReapedServer } from './worktreeServers.js';

export interface PermanentDeleteLifecycle {
  /** Invalidate window-local UI before any late action can target the ticket. */
  closePanel(ticketId: number): void;
  /** Remove bytes after the row transaction wins against in-flight inserts. */
  reap(ticketId: number): Promise<void>;
  /** Release the ticket's port allocations as its worktrees come down. The row
   *  transaction clears `port_allocations` too, so this is the belt to that
   *  suspenders: a worktree that fails part-way still frees its ports. */
  allocator: PortAllocator;
  /** The `<globalStorage>/graph/<projectSlug>` root; when set, deleteTicket
   *  also removes the ticket's graph byte subtree after its rows (Slice 2
   *  Task 8; the activation sweep covers the absent case). */
  graphBytesRoot?: string;
  /** The `<globalStorage>/artifacts` root; when set, deleteTicket also removes
   *  the ticket's gate console-log dir after its rows (the activation sweep
   *  covers the absent case). */
  artifactsRoot?: string;
}

/** What a permanent delete had to intervene on beyond the row transaction. */
export interface PermanentDeleteOutcome {
  /**
   * Servers the deletion stopped — or could not stop — inside the ticket's
   * worktrees. Shaped for `describeReap` so the caller names each one: a delete
   * that silently kills a running dev server, or that silently could not, is
   * exactly the invisibility this routing exists to end.
   */
  reapedServers: ReapedServer[];
  /**
   * Worktrees whose git/disk removal threw. The ticket's rows still go — the
   * tombstone wins, because cleanup must never strand a user-requested delete —
   * so a value above zero means a worktree directory may survive on disk.
   */
  failedWorktrees: number;
}

/**
 * Coordinate the store and filesystem halves of irreversible ticket deletion.
 *
 * Worktree teardown runs FIRST, before the row transaction, so the servers
 * running inside each worktree are stopped and the tree is taken off disk while
 * both pid and path are still known. `removeWorktree` is the single removal
 * choke point, but a permanent delete used to bypass it: it deleted the
 * `servers`/`worktrees` rows and left the processes detached and reparented to
 * init, holding their ports and memory while serving a directory nobody would
 * ever reap (869ed2n50). The row delete stays synchronous/transactional;
 * filesystem cleanup remains async and is awaited so its failure reaches the UI
 * instead of becoming a fire-and-forget orphan with no retry handle.
 *
 * Worktree removal is fault-isolated per row: a git failure is counted and
 * reported, never allowed to block the tombstone.
 */
export async function deleteTicketPermanently(
  store: Store,
  ticketId: number,
  lifecycle: PermanentDeleteLifecycle,
): Promise<PermanentDeleteOutcome> {
  const reapedServers: ReapedServer[] = [];
  let failedWorktrees = 0;
  const allocator = lifecycle.allocator;
  for (const wt of listWorktreesByTicket(store, ticketId)) {
    try {
      reapedServers.push(
        ...removeWorktree(store, { ticketId: wt.ticketId, repoPath: wt.repo, path: wt.path }, allocator),
      );
    } catch {
      failedWorktrees += 1;
    }
  }
  deleteTicket(store, ticketId, lifecycle.graphBytesRoot, lifecycle.artifactsRoot);
  // Both operations are synchronous: the DB tombstone is visible before any
  // local in-flight action can resume, then its panel is invalidated before the
  // first asynchronous yield in filesystem cleanup.
  lifecycle.closePanel(ticketId);
  await lifecycle.reap(ticketId);
  return { reapedServers, failedWorktrees };
}
