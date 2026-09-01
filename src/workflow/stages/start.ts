import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import type { TicketingConfig } from '../../manifest/types.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';
import { providerRef, type AdvanceResult } from './done.js';

/**
 * Start stage (§ ticket 869e7x7a3). Mirrors `advanceTicketOnShip` (done.ts) on
 * the other end of the lifecycle: pushes the ticket's post-start status through
 * the ticketing provider seam when work begins, instead of leaving the tracker's
 * status a manual chore.
 */

/**
 * Fallback status name pushed when `advanceOnStart` is on but `startStatus` was
 * left blank or unset — most trackers ship a status with this exact name, so an
 * incomplete config still does something useful instead of silently no-op'ing.
 */
export const DEFAULT_START_STATUS = 'in progress';

/**
 * Push the configured start-of-work status, when configured and addressable.
 * Same shape and failure semantics as `advanceTicketOnShip`: throws whatever the
 * provider throws — the caller warns; it never blocks the session from opening.
 */
export async function advanceTicketOnStart(
  store: Store,
  ticketId: number,
  ticketing: TicketingConfig | undefined,
  provider: TicketingProvider,
  debug?: (message: string) => void,
): Promise<AdvanceResult> {
  debug?.(`[ticketing] start ticket ${ticketId}: advanceOnStart ${ticketing?.advanceOnStart ? 'enabled' : 'disabled'}`);
  if (!ticketing?.advanceOnStart) return { advanced: false, reason: 'disabled' };
  const status = (ticketing.startStatus ?? '').trim() || DEFAULT_START_STATUS;

  const ref = providerRef(getTicket(store, ticketId));
  if (!ref) {
    debug?.(`[ticketing] start ticket ${ticketId}: no provider ref — skipping status push`);
    return { advanced: false, reason: 'no-ref' };
  }

  debug?.(`[ticketing] start ticket ${ticketId}: pushing '${status}' to ref '${ref}'`);
  await provider.updateStatus(ref, status);
  return { advanced: true, status };
}
