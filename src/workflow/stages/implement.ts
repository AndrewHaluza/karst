import type { Store } from '../../store/db.js';
import type { StageKey, Verdict } from '../../model/types.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';
import { completeImplementationRun } from '../../store/implementationRuns.js';

/**
 * The transition surface the marker uses — the machine's `transition`, which
 * accepts a premutate folded into the same transaction as the verdict.
 */
export type ImplementTransition = (
  store: Store,
  ticketId: number,
  from: StageKey,
  verdict: Verdict,
  premutate?: () => void,
) => StageKey;

/**
 * Implement stage boundary (§T4.3, §5.4). Implement *is* the M3 interactive
 * session; there is no deterministic signal a machine can read from it, so the
 * impl→uat transition is an **explicit marker** — the agent CLI
 * `karst stage impl pass` or a user action — never a `Stop` hook alone (the
 * no-inference guarantee: a session ending is not a verdict).
 *
 * The marker is also the ONLY completion authority for the stable
 * implementation run (v28): as the transition's premutate,
 * `completeImplementationRun` closes the active segment and its Session
 * process run and marks the run passed, inside the SAME transaction as the
 * stage advance — evidence and verdict commit together or not at all. A
 * refused (stale) marker throws before the premutate, so nothing about the
 * run changes.
 */
export function markImplementDone(
  store: Store,
  ticketId: number,
  transitionFn: ImplementTransition = transition,
  debug?: (message: string) => void,
): StageKey {
  debug?.(`[driver] impl marker: ticket ${ticketId} marked done — advancing impl→uat`);
  const next = transitionFn(store, ticketId, 'impl', { kind: 'passed' }, () => {
    completeImplementationRun(store, ticketId, nowIso());
  });
  debug?.(`[driver] impl marker: ticket ${ticketId} now at '${next}'`);
  return next;
}
