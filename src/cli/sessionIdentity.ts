import type { Ticket } from '../store/tickets.js';
import { formatTicketRef } from '../model/entityId.js';

/**
 * The attested session identity shared by the agent-write verbs (`message` and
 * `notes`): a ticket's display label, and the `--ticket` vs session-env
 * cross-check. `--ticket` is argv — a claim, not a credential — so the only
 * check is that it agrees with the session env's `KARST_TICKET`. Attested, not
 * unforgeable; the blast radius is what the verb itself can do.
 */

/** A ticket's display label: `T<id> · <key>`, else `T<id>`. */
export function ticketLabel(t: Pick<Ticket, 'id' | 'key'>): string {
  return formatTicketRef(t.id, t.key);
}

/** Refuse a `--ticket` that disagrees with the session env's own ticket. */
export function assertSenderMatchesSession(sender: Ticket, sessionKey: string | undefined): void {
  if (sessionKey === undefined || sessionKey === '') return;
  if (sessionKey !== sender.key) {
    throw new Error(
      `--ticket resolves to '${ticketLabel(sender)}' but this session's KARST_TICKET is '${sessionKey}' — ` +
        `refusing: a session may act only as its own ticket`,
    );
  }
}
