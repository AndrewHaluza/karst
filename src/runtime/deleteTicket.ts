import type { Store } from '../store/db.js';
import { deleteTicket } from '../store/tickets.js';

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
}

/**
 * Coordinate the store and filesystem halves of irreversible ticket deletion.
 * The row delete stays synchronous/transactional; filesystem cleanup remains
 * async and is awaited so its failure reaches the UI instead of becoming a
 * fire-and-forget orphan with no retry handle.
 */
export async function deleteTicketPermanently(
  store: Store,
  ticketId: number,
  lifecycle: PermanentDeleteLifecycle,
): Promise<void> {
  deleteTicket(store, ticketId, lifecycle.graphBytesRoot, lifecycle.artifactsRoot);
  // Both operations are synchronous: the DB tombstone is visible before any
  // local in-flight action can resume, then its panel is invalidated before the
  // first asynchronous yield in filesystem cleanup.
  lifecycle.closePanel(ticketId);
  await lifecycle.reap(ticketId);
}
