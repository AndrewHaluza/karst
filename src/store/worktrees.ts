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

/**
 * Re-arm a lease `takeForcePushLease` already consumed, because the push it
 * was consumed for did not land (rejected `--force-with-lease`, a dropped
 * connection, anything short of success). The branch is STILL rewritten —
 * that fact did not become false because the push failed — so an ordinary
 * push on the next retry would be rejected as a non-fast-forward forever with
 * no way to recover short of a manual force push. Unconditional (no `WHERE
 * needs_force_push IS NULL` guard): a concurrent `changeBaseRef` that armed
 * a fresh lease in the gap must not be clobbered back to armed-by-us — either
 * writer setting it to 1 leaves the correct end state.
 */
export function armForcePushLease(store: Store, ticketId: number, repo: string): void {
  store.db
    .prepare(
      `UPDATE worktrees SET needs_force_push = 1 WHERE ticket_id = ? AND repo = ?`,
    )
    .run(ticketId, repo);
}
