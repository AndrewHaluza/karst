import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { manualProvider, type TicketingProvider } from '../../integrations/ticketing.js';

/**
 * Done stage (§T4.5, §11, §15). Updates the ticket's status through the
 * ticketing provider (swappable seam) — MVP defaults to the manual provider,
 * which records the update locally. Uses the ticket's `key` as the external
 * identifier the provider understands.
 *
 * [L4] Independent of ship: PRs and ticket-status have separate failure modes,
 * so this never depends on ship having succeeded — only on the ticket id.
 */
export async function updateTicketStatus(
  store: Store,
  ticketId: number,
  status: string,
  provider: TicketingProvider = manualProvider(),
): Promise<void> {
  const ticket = getTicket(store, ticketId);
  const key = ticket.key ?? String(ticketId);
  await provider.updateStatus(key, status);
}
