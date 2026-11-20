import type { Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { ticketLabel } from '../model/notifyText.js';

/**
 * The ticket name of a toast (@arch:NTF-03). It never throws: a toast reports a failure,
 * so a missing ticket row (a deleted ticket, a closed store) must not turn it into an
 * unhandled rejection. The fallback is the bare `T<n>` ref.
 */
export function ticketToastLabel(store: Store, ticketId: number): string {
  try {
    const t = getTicket(store, ticketId);
    return ticketLabel(ticketId, t.key, t.title);
  } catch {
    return ticketLabel(ticketId, null, null);
  }
}
