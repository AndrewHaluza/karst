import type { StageKey } from '../model/types.js';
import { shouldResumeSession } from './resumeDecision.js';

/**
 * What the returning-user session entry point (sidebar button, dashboard Now
 * line) will DO when clicked, and the verb it should read.
 *
 * `continue` — resume the captured session in place (§5.3): the user picks up
 * the exact context they left. `start` — no resumable session, so a fresh,
 * fully-seeded launch is correct (a never-run draft OR a stage with no
 * interactive continuation).
 */
export type SessionActionKind = 'continue' | 'start';

export interface SessionAction {
  kind: SessionActionKind;
  /** The button verb — "Continue" or "Start". */
  label: string;
}

/**
 * Decide continue-vs-start for a ticket's entry point. Continue detection is
 * `shouldResumeSession` verbatim so the button's promise and `openSession`'s
 * actual `--resume` decision can never drift — the label is a preview of what
 * the same predicate will resolve at launch.
 */
export function sessionAction(t: {
  sessionId: string | null;
  stageCurrent: StageKey | string | null;
}): SessionAction {
  return shouldResumeSession({ sessionId: t.sessionId, stageCurrent: t.stageCurrent as StageKey })
    ? { kind: 'continue', label: 'Continue' }
    : { kind: 'start', label: 'Start' };
}
