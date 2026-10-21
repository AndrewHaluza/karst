import type { HookPayload } from '../../hooks/dispatch.js';

/** The session must stay idle this long after the accepted marker before the host ends it (arch:AC-37). */
export const SESSION_END_SETTLE_MS = 10_000;

export interface SessionEnderDeps {
  /** The ticket's CURRENT launch generation. */
  readonly launchIdFor: (ticketId: number) => string | undefined;
  /** The provider session id bound to the ticket. */
  readonly boundSessionId: (ticketId: number) => string | undefined;
  /** Sync + stop the ticket's sandbox; the closed session then raises `session-closed`. */
  readonly stop: (ticketId: number) => Promise<unknown>;
  readonly log: (message: string) => void;
  readonly settleMs?: number;
  /** Returns a cancel function. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface SessionEnder {
  /** The bridge's marker CLI passed for the ticket's current launch. */
  accepted(ticketId: number): void;
  /** Every applied hook event of a ticket. */
  onHook(ticketId: number, payload: HookPayload): void;
}

/**
 * A sandboxed agent whose done marker was accepted may sit at `session.idle`
 * forever (opencode2 `--standalone` never exits), so no `session-closed`
 * trigger fires. The HOST ends it: accepted marker + idle of the current
 * launch's bound session + still idle after the settle delay → `stop`.
 * Idle between interactive turns never qualifies: no accepted marker, no stop.
 */
export function createSandboxSessionEnder(deps: SessionEnderDeps): SessionEnder {
  const settleMs = deps.settleMs ?? SESSION_END_SETTLE_MS;
  const schedule = deps.schedule ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return () => clearTimeout(h); });
  /** ticket → launch generation whose marker was accepted. */
  const acceptedLaunch = new Map<number, string>();
  /** ticket → the session that went idle in the current launch (cleared by any newer activity). */
  const idleSession = new Map<number, { sessionId: string; launchId: string }>();
  const timers = new Map<number, () => void>();

  const cancel = (ticketId: number): void => {
    timers.get(ticketId)?.();
    timers.delete(ticketId);
  };
  /** Accepted for this launch, and the idle session is the bound one of this launch. */
  const qualifies = (ticketId: number): string | undefined => {
    const launch = deps.launchIdFor(ticketId);
    const idle = idleSession.get(ticketId);
    if (launch === undefined || idle === undefined) return undefined;
    if (acceptedLaunch.get(ticketId) !== launch || idle.launchId !== launch) return undefined;
    return deps.boundSessionId(ticketId) === idle.sessionId ? idle.sessionId : undefined;
  };
  const arm = (ticketId: number): void => {
    if (qualifies(ticketId) === undefined) return;
    cancel(ticketId);
    timers.set(ticketId, schedule(() => {
      timers.delete(ticketId);
      const sessionId = qualifies(ticketId);
      if (sessionId === undefined) return;
      idleSession.delete(ticketId);
      acceptedLaunch.delete(ticketId);
      deps.log(`stage driver: ticket ${ticketId} session ${sessionId} idle after its done marker was accepted — ending the sandbox session`);
      void deps.stop(ticketId).catch((err: unknown) => deps.log(`ticket ${ticketId} ending the sandbox session failed: ${err instanceof Error ? err.message : String(err)}`));
    }, settleMs));
  };

  return {
    accepted(ticketId) {
      const launch = deps.launchIdFor(ticketId);
      if (launch === undefined) return;
      acceptedLaunch.set(ticketId, launch);
      arm(ticketId); // the idle line may have beaten the marker's reply
    },
    onHook(ticketId, payload) {
      if (payload.hook_event_name === 'session.idle') {
        if (payload.session_id === undefined || payload.launchId === undefined) return;
        idleSession.set(ticketId, { sessionId: payload.session_id, launchId: payload.launchId });
        arm(ticketId);
        return;
      }
      idleSession.delete(ticketId);
      cancel(ticketId);
    },
  };
}
