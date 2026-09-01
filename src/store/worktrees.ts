import type { Store } from './db.js';

/**
 * Whether this branch was rewritten since its last push — and clear the flag in
 * the same statement, so a lease is consumed exactly once. A flag that survived
 * its push would force-push every later ship for the life of the ticket.
 */
export function takeForcePushLease(store: Store, ticketId: number, repo: string): boolean {
  const result = store.db
    .prepare(
      `UPDATE worktrees SET needs_force_push = NULL
        WHERE ticket_id = ? AND repo = ? AND needs_force_push = 1`,
    )
    .run(ticketId, repo);
  return result.changes > 0;
}
