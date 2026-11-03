import { makeSessionHandOff, type SessionHandOffDeps } from './conflictResolveOps.js';

/**
 * Wrap a session hand-off so a refusal has a reason. `makeSessionHandOff` returns nothing, so a
 * caller could not tell "nudged or opened" from "nothing happened". The wrapper refuses a paused
 * ticket and a provider without the 'sessions' capability before it delivers.
 */
export interface GuardedHandOffDeps {
  readonly paused: () => boolean;
  readonly sessionsAvailable: () => boolean;
  readonly handOff: (prompt: string, repo: string) => void;
}

/** Returns null when the prompt was delivered, else the reason no session received it. */
export function guardedHandOff(deps: GuardedHandOffDeps): (prompt: string) => string | null {
  return (prompt) => {
    if (deps.paused()) return 'the ticket is paused. Unpause it, then open a session.';
    if (!deps.sessionsAvailable()) return "the agent core of this ticket does not support sessions.";
    deps.handOff(prompt, '');
    return null;
  };
}

/** The guarded hand-off over the live session seams: nudge a live terminal, else open a seeded session. */
export function ticketHandOff(
  deps: SessionHandOffDeps & Pick<GuardedHandOffDeps, 'paused' | 'sessionsAvailable'>,
): (prompt: string) => string | null {
  return guardedHandOff({ paused: deps.paused, sessionsAvailable: deps.sessionsAvailable, handOff: makeSessionHandOff(deps) });
}
