/**
 * The conflict round hand-off (@arch:AP-01), shared by the Autopilot round and the Resolve conflicts click.
 * A live host or sandbox session gets the brief as a stored `conflict` delivery (`fix_deliveries`, @arch:V77) and the
 * fixed pointer line through the per-core route; the agent's `fix-brief --ack` read is the receipt. A closed session is
 * seeded with the full brief, and the seed is its own receipt (`delivered_via='seed'`). A graph ticket keeps the
 * direct route: nudge a live session, else open one.
 */
export interface ConflictDeliveryDeps {
  readonly isLive: (ticketId: number) => boolean;
  readonly isGraphTicket: (ticketId: number) => boolean;
  readonly nudge: (ticketId: number, text: string) => boolean;
  readonly focus: (ticketId: number) => void;
  readonly open: (ticketId: number, brief: string, repo: string) => void;
  /** Stores the snapshot and arms or types the pointer. False when no session could take it. */
  readonly deliverLive: (ticketId: number, repo: string, brief: string) => boolean;
  /** Stores the snapshot already read: the launch seed carries the brief. */
  readonly recordSeed: (ticketId: number, repo: string, brief: string) => void;
  readonly key: (ticketId: number) => string;
  readonly debug: (message: string) => void;
}

export type ConflictDeliver = (ticketId: number, brief: string, repo: string) => void;

export function makeConflictDelivery(d: ConflictDeliveryDeps): ConflictDeliver {
  const log = (id: number, what: string): void => d.debug(`[ship] ticket ${d.key(id)}: conflict brief ${what}`);
  const seed = (id: number, brief: string, repo: string): void => {
    d.open(id, brief, repo);
    d.recordSeed(id, repo, brief);
    log(id, 'sent as the seed of a new session');
  };
  return (id, brief, repo) => {
    if (d.isGraphTicket(id)) {
      if (d.nudge(id, brief)) {
        d.focus(id);
        log(id, 'sent to the live graph session');
        return;
      }
      d.open(id, brief, repo);
      log(id, 'sent as the seed of a new graph session');
      return;
    }
    if (d.isLive(id) && d.deliverLive(id, repo, brief)) {
      d.focus(id);
      log(id, 'stored; the live session is pointed at it');
      return;
    }
    seed(id, brief, repo);
  };
}
