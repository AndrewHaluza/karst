import type { Store } from '../store/db.js';
import type { StageKey, Verdict } from '../model/types.js';
import { transition } from './machine.js';
import { nowIso } from '../model/time.js';
import {
  beginLiveFixExecution,
  completeFixExecution,
  interruptFixExecution,
} from '../store/recoveryRounds.js';

/**
 * The FIX side of causal recovery tracking (Task 6).
 *
 * Production recovery NEVER calls `workflow/stages/fix.ts`'s headless
 * `runFix` helper — the driver resumes the agent into an interactive session
 * (a live nudge or a relaunched terminal), so the fix is tracked by its
 * process run and its recovery round, not by a headless invocation. This
 * module is that production route:
 *
 *  - `resumeFixExecution` is the driver→agent handoff: a live session opens
 *    the Fix process run and attaches it to the round BEFORE the brief is
 *    delivered; a closed session just launches (its launch intent, recorded by
 *    the host at `onLaunchPrepared`, owns the round until the SessionStart
 *    confirms the process run);
 *  - `markFixDone` is the `stage fix pass` marker — the ONLY completion
 *    authority — folding `completeFixExecution` into the marker's transition
 *    transaction so the process run passes, the round moves to `revalidating`
 *    and the ticket advances fix→uat atomically.
 */

export interface FixTransition {
  (
    store: Store,
    ticketId: number,
    from: StageKey,
    verdict: Verdict,
    premutate?: () => void,
  ): StageKey;
}

/**
 * The `stage fix pass` marker: transition fix→uat (the graph's only legal edge
 * out of fix — revalidation ALWAYS re-enters uat) with the recovery
 * completion folded into the same transaction as the verdict.
 */
export function markFixDone(
  store: Store,
  ticketId: number,
  transitionFn: FixTransition = transition,
): StageKey {
  return transitionFn(store, ticketId, 'fix', { kind: 'passed' }, () => {
    completeFixExecution(store, ticketId, nowIso());
  });
}

export type ResumeFixOutcome = 'nudged' | 'launched';

export interface ResumeFixExecutionOpts {
  ticketId: number;
  /**
   * The committed recovery round this fix answers; null for a ticket parked at
   * fix before rounds existed (v30) — such a ticket resumes untracked, exactly
   * as before.
   */
  roundId: number | null;
  /**
   * The session's recorded active provider/model/agent snapshot (the session
   * manager's — or, for a configured Fix identity, the resolved assignment),
   * captured into the Fix process run so the execution carries the identity
   * that is actually running. Null = unknown, never invented.
   */
  identity: { provider: string | null; model: string | null; agentName?: string | null } | null;
  startedAt: string;
  prompt: string;
  /** True when the ticket's session terminal is live (open, or a revived handle). */
  isLive: () => boolean;
  nudge: (prompt: string) => boolean;
  open: () => void;
}

/**
 * Resume the agent into fix, tracking the execution against the committed
 * recovery round:
 *
 *  - LIVE session: open the Fix process run and attach it to the round BEFORE
 *    the prompt is delivered, so the execution is durably owned from its first
 *    token. A delivery failure interrupts both the execution and the round.
 *  - CLOSED session: launch (the host's `onLaunchPrepared` records the fix
 *    launch intent against the round); the process run opens only when the
 *    matching SessionStart is accepted.
 */
export function resumeFixExecution(store: Store, opts: ResumeFixExecutionOpts): ResumeFixOutcome {
  const { ticketId, roundId, identity, startedAt, prompt, isLive, nudge, open } = opts;
  if (roundId === null) {
    return nudge(prompt) ? 'nudged' : (open(), 'launched');
  }
  if (isLive()) {
    beginLiveFixExecution(store, {
      ticketId,
      roundId,
      provider: identity?.provider ?? null,
      model: identity?.model ?? null,
      agentName: identity?.agentName ?? null,
      startedAt,
    });
    try {
      if (!nudge(prompt)) throw new Error('live Fix brief was not delivered');
    } catch (error) {
      interruptFixExecution(store, roundId, startedAt);
      throw error;
    }
    return 'nudged';
  }
  open();
  return 'launched';
}
