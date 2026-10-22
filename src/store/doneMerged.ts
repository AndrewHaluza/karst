import type { Store } from './db.js';

/**
 * Done tickets whose work is on the remote: at least one PR, every undismissed
 * PR merged. A done ticket with no PR (nothing-to-merge) is not included: its
 * sandbox may hold work that never left it (arch:AC-37).
 */
const DONE_MERGED_SQL = `SELECT t.id FROM tickets t
  WHERE t.archived_at IS NULL AND t.stage_current = 'done'
    AND EXISTS (SELECT 1 FROM prs p WHERE p.ticket_id = t.id AND p.merged_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM prs p WHERE p.ticket_id = t.id AND p.merged_at IS NULL AND p.dismissed_at IS NULL)`;

export function doneMergedTicketIds(store: Store): Set<number> {
  return new Set((store.db.prepare(DONE_MERGED_SQL).all() as { id: number }[]).map((r) => r.id));
}

export function isDoneMerged(store: Store, ticketId: number): boolean {
  return doneMergedTicketIds(store).has(ticketId);
}
