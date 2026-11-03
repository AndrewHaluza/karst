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
