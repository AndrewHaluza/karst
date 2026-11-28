/**
 * D823: the ssh tunnels (`-L` for published ports, `-R` for baseline host
 * ports) die with the window. After a reload, the window must re-open them for
 * each ssh ticket that still needs them. A ticket that session recovery
 * re-launches re-opens its tunnels through that launch; this module names the
 * other tickets: a live session that the window adopted, and a kept sandboxed
 * stack (a running service, no session). Host-agnostic: the store is the only input.
 */
import type { Store } from '../../store/db.js';
import type { TicketPlacement } from '../../store/placement.js';

export interface SshTunnelReattachInput {
  /** The tickets of this window's project, in order. */
  readonly tickets: readonly number[];
  /** Tickets whose restored live session this window adopted. */
  readonly adopted: ReadonlySet<number>;
  /** Tickets that session recovery re-launches; their launch re-opens the tunnels. */
  readonly recovering: ReadonlySet<number>;
  readonly placementOf: (ticketId: number) => TicketPlacement | null | undefined;
  readonly hasRunningService: (ticketId: number) => boolean;
}

/** The ssh tickets whose tunnels this window re-opens after a reload. */
export function sshTunnelReattachTickets(input: SshTunnelReattachInput): number[] {
  return input.tickets.filter((id) =>
    !input.recovering.has(id) &&
    input.placementOf(id)?.backend === 'ssh' &&
    (input.adopted.has(id) || input.hasRunningService(id)));
}

const RUNNING_SANDBOX_SERVICE_SQL =
  "SELECT 1 FROM servers WHERE ticket_id = ? AND status = 'running' AND sandbox IS NOT NULL LIMIT 1";

/** Does the ticket have a running service inside its sandbox (a kept stack)? */
export function hasRunningSandboxService(store: Store, ticketId: number): boolean {
  return store.db.prepare(RUNNING_SANDBOX_SERVICE_SQL).get(ticketId) !== undefined;
}
