import type { Store } from '../store/db.js';

/**
 * The one marker state a stage may not be marked done in: the agent asked the
 * user a question and is blocked on their input. A stage whose agent is
 * WAITING cannot be complete — the agent literally stopped to ask, so its
 * work is not done. Refusing the marker here is what stops the "marker fired
 * when the agent asked me a question" premature-advance (the writing-plans
 * handoff asks "Which approach?" — the ticket must stay at impl until the
 * user answers and the agent actually finishes).
 *
 * `null` (no agent yet) and `running`/`idle` are NOT refused: `running` is
 * the normal state while the agent fires the marker from within its session,
 * and `idle` is a finished session the marker may legitimately close.
 *
 * Lives here, not in `cli/stage.ts`, so a trusted host caller (a dashboard
 * button) can share the SAME check rather than reimplementing it or, worse,
 * calling a marker guard that skips it — see `graphMarkerGuard.ts`'s
 * `fireGraphImplMarkerFromHost`. `cli/stage.ts` remains the only place
 * AGENT-facing argv reaches a marker; this file is the invariant both
 * callers enforce, not a second way to fire one.
 */
export function assertMarkerNotWhileWaiting(agentState: string | null | undefined): void {
  if (agentState === 'waiting') {
    throw new Error(
      'cannot mark this stage done: the agent is currently waiting for your input ' +
        '(it asked a question). A stage whose agent is waiting on the user is not complete — ' +
        'answer the question, then re-fire the marker when the work is actually done.',
    );
  }
}

/** The ticket's current `agent_state`, read live — the same read `runStageCommand` does. */
export function liveAgentState(store: Store, ticketId: number): string | null {
  if (!store.db) return null;
  return (
    (
      store.db.prepare('SELECT agent_state FROM tickets WHERE id = ?').get(ticketId) as
        | { agent_state: string | null }
        | undefined
    )?.agent_state ?? null
  );
}
