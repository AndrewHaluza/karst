import type { Store } from '../../store/db.js';
import { getTicket, type Ticket } from '../../store/tickets.js';
import type { TicketingConfig } from '../../manifest/types.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';

/**
 * Done stage (§T4.5, §11, §15). Pushes the ticket's post-ship status through the
 * ticketing provider (swappable seam).
 *
 * [L4] Independent of ship: PRs and ticket-status have separate failure modes, so
 * this never depends on ship having succeeded — only on the ticket id. Ship has
 * already transitioned to done by the time this runs (`ship.ts:120`), so a failure
 * here cannot drag a shipped ticket back to red.
 */

/**
 * The provider-side handle for a ticket: the ref the provider itself returned at
 * fetch, never the user-editable `key`. `null` → nothing addressable.
 *
 * `key` is NOT usable here. It is seeded from the fetched ref at create
 * (`ui/ticketForm/actions.ts:129`) but `updateTicketCore` lets the user edit it to
 * arbitrary text, and a manual ticket has a hand-typed `key` and no ref at all.
 * Sending it would address a task nobody ever fetched.
 */
export function providerRef(ticket: Ticket): string | null {
  const ref = (ticket.sourceRef ?? '').trim();
  return ref === '' ? null : ref;
}

/** Why the push did nothing, so the caller can log rather than guess. */
export type AdvanceResult =
  | { advanced: true; status: string }
  | { advanced: false; reason: 'disabled' | 'no-ref' };

/**
 * The reportable shape for a status-push skip: the one severity the caller may
 * emit (DEBUG) plus the line to emit. `null` → nothing to say.
 */
export type StatusPushSkip = { level: 'debug'; message: string } | null;

/**
 * Turn an `AdvanceResult` into the note the host should log, if any.
 *
 * `no-ref` is a NORMAL state, never a fault: a manual ticket has no provider
 * task to move (`providerRef` returns null by design), so the push is skipped
 * and the caller logs a DEBUG note — a missing ref must never read as an ERROR
 * in the channel. `disabled` and `advanced` have nothing to say at all.
 */
export function statusPushSkipNote(
  event: 'started' | 'completed',
  ticketId: number,
  result: AdvanceResult,
): StatusPushSkip {
  if (result.advanced || result.reason === 'disabled') return null;
  return {
    level: 'debug',
    message: `ticket #${ticketId} ${event} without a status update: no provider ref`,
  };
}

/**
 * Push the configured post-ship status, when configured and addressable. Owns the
 * whole decision so the (untestable) `vscode` binding holds one call and every
 * branch that could reach a live provider is covered by tests.
 *
 * Throws whatever the provider throws — the caller warns; it never fails the ship.
 */
export async function advanceTicketOnShip(
  store: Store,
  ticketId: number,
  ticketing: TicketingConfig | undefined,
  provider: TicketingProvider,
): Promise<AdvanceResult> {
  const status = ticketing?.advanceOnShip ? (ticketing.shipStatus ?? '').trim() : '';
  if (!status) return { advanced: false, reason: 'disabled' };

  const ref = providerRef(getTicket(store, ticketId));
  if (!ref) return { advanced: false, reason: 'no-ref' };

  await provider.updateStatus(ref, status);
  return { advanced: true, status };
}
