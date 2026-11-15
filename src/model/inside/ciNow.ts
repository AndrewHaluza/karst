/**
 * The "Now" line under the Inside ship header (T1140): while GitHub CI runs and nothing needs the user, it names who
 * works, how far CI is, and what comes next. It restates facts the rows hold, never a row's own text (the header is
 * not a second process row).
 */
import type { InsideNowView } from './types.js';

/** One open PR whose checks pend. */
export interface CiWaitingPr {
  readonly label: string;
  readonly number: number | null;
  readonly total: number;
  readonly passed: number;
  readonly pending: number;
}

export interface CiNowInput {
  readonly waiting: readonly CiWaitingPr[];
  /** Auto-fix is on for the ticket: a red check goes to the agent, else the user chooses. */
  readonly autofixEffective: boolean;
}

export function ciNowView(input: CiNowInput): InsideNowView | undefined {
  const { waiting } = input;
  if (waiting.length === 0) return undefined;
  const names = waiting.map((w) => (w.number === null ? w.label : `${w.label} #${w.number}`)).join(', ');
  const sum = (pick: (w: CiWaitingPr) => number): number => waiting.reduce((n, w) => n + pick(w), 0);
  return {
    now: `Now: GitHub CI runs on ${names} — ${sum((w) => w.passed)} of ${sum((w) => w.total)} passed, ${sum((w) => w.pending)} pending. Nothing for you to do.`,
    next: `Next: all green → Merge. A red check → ${input.autofixEffective ? 'Auto-fix sends it to the agent.' : 'you choose.'}`,
  };
}
