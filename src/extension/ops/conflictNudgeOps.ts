/**
 * The Autopilot conflict round hand-off (@arch:AP-01). A live host session gets one short pointer line, because a
 * ~1400-character brief typed into the TUI is split by its paste handling and can be left unsubmitted. A sandboxed
 * session has no host CLI, so it gets the full brief. A new session is seeded with the full brief.
 * The Resolve conflicts click does not use this module.
 */
export interface ConflictDeliveryDeps {
  readonly nudge: (ticketId: number, text: string) => boolean;
  readonly focus: (ticketId: number) => void;
  readonly open: (ticketId: number, brief: string, repo: string) => void;
  /** The pointer line for a host session. */
  readonly pointer: (ticketId: number, repo: string) => string;
  readonly key: (ticketId: number) => string;
  readonly debug: (message: string) => void;
}

export interface ConflictDelivery {
  readonly deliver: (ticketId: number, brief: string, repo: string, sandboxed: boolean) => void;
  /** Types the same text again. False when no round text is held or no session is live. */
  readonly resend: (ticketId: number) => boolean;
}

export function makeConflictDelivery(d: ConflictDeliveryDeps): ConflictDelivery {
  const typed = new Map<number, string>();
  const log = (id: number, what: string): void => d.debug(`[ship] autopilot ticket ${d.key(id)}: conflict brief ${what}`);
  return {
    deliver: (id, brief, repo, sandboxed) => {
      const text = sandboxed ? brief : d.pointer(id, repo);
      typed.set(id, text);
      if (d.nudge(id, text)) {
        d.focus(id);
        log(id, sandboxed ? 'sent to the live session' : 'sent to the live session as a pointer');
        return;
      }
      d.open(id, brief, repo);
      log(id, 'sent as the seed of a new session');
    },
    resend: (id) => {
      const text = typed.get(id);
      if (text === undefined) return false;
      typed.delete(id);
      if (!d.nudge(id, text)) {
        log(id, 'not sent again: no live session');
        return false;
      }
      log(id, 'sent again to the live session');
      return true;
    },
  };
}
