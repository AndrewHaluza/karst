import type { StageKey } from '../types.js';
import type { StepperCell } from '../stepper.js';

/**
 * How an operation row reads.
 *
 * `note` is not a status. It is karst stating a fact it cannot honestly dress as
 * a pass or a fail — a gate the repo cannot answer, a phase karst does not
 * observe, a rule about what will happen next. Keeping it in the union is what
 * stops the panel inventing a verdict to fill a row.
 */
export type OpStatus = 'pass' | 'fail' | 'run' | 'wait' | 'pending' | 'note';

/** One line inside a stage: what karst did, or plainly why it cannot say. */
export interface StageOp {
  status: OpStatus;
  /** Short left-hand name — `lint`, `worktree`, `agent`. */
  name: string;
  /** The machine detail — `npm run lint — exit 1`. */
  detail: string;
  /** Preformatted duration, or '' when there is none to state. */
  duration: string;
}

/** The state dot beside the "Inside <stage>" header. */
export type InsideDot = 'done' | 'run' | 'wait' | 'fail' | 'idle' | 'pend';

/** Everything the activity strip renders for ONE stage. A snapshot, no functions. */
export interface StageInside {
  stageKey: StageKey;
  /** Display title — `Implementation`, `UAT`. */
  title: string;
  dot: InsideDot;
  /** `12:23:06 · 51.7s · attempt 1`, or `has not run yet`. */
  clock: string;
  /**
   * Observed rows. EMPTY means nothing ran — the view shows `blurb` instead.
   * Empty rows would imply karst tried something and got nothing back.
   */
  ops: StageOp[];
  /** The static "what happens here" copy. Always present. */
  blurb: string;
}

/** Display titles for the strip header. */
export const STAGE_TITLES: Readonly<Record<StageKey, string>> = {
  scope: 'Scope',
  impl: 'Implementation',
  uat: 'UAT',
  review: 'Review',
  fix: 'Fix',
  ship: 'Ship',
  done: 'Done',
};

/**
 * What each stage does, taken from the runners in `src/workflow/stages/`. This
 * is what a not-yet-run stage shows, so selecting a pending stage still answers
 * "what will happen here?" rather than showing an empty panel.
 */
export const STAGE_BLURBS: Readonly<Record<StageKey, string>> = {
  scope:
    'Validates the hot repo set against the manifest, then creates one worktree per hot repo off the baseline branch. Nothing is created until you confirm.',
  impl: 'The interactive agent session. Advances only on the explicit done marker — a session ending is not a verdict.',
  uat: "Runs the repo's own test script in the ticket's worktree. The exit code is the verdict; nothing self-reported counts.",
  review:
    'Runs lint, typecheck and test. Every gate the repo can answer must exit 0. The diff opens for you either way.',
  fix: 'Resumes the captured session so the agent keeps its context, then re-enters the uat gate.',
  ship: 'Commits, pushes, and opens one PR per hot repo with an agent-written description.',
  done: 'Terminal. Nothing runs here — arriving is completing.',
};

/**
 * A span as a person reads it. Sub-minute keeps a decimal because gate times
 * live there; above a minute the decimal is noise.
 */
export function formatDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (!startedAt || !endedAt) return '';
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Time of day, in the reader's own locale. Empty for an unparseable stamp. */
export function formatTime(at: string | null | undefined): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/**
 * The strip's header line for a stage.
 *
 * `now` is injected rather than read from the clock so this stays pure and
 * testable; a running stage's elapsed time is therefore as fresh as the last
 * state push, which is every driver progress tick.
 */
export function formatClock(cell: StepperCell, now: string): string {
  const attempt = cell.attempt && cell.attempt > 0 ? ` · attempt ${cell.attempt}` : '';

  if (!cell.startedAt) {
    return cell.status === 'pending' ? 'has not run yet' : '';
  }
  if (cell.status === 'running') {
    const elapsed = formatDuration(cell.startedAt, now);
    return `started ${formatTime(cell.startedAt)}${elapsed ? ` · ${elapsed} elapsed` : ''}${attempt}`;
  }
  const took = formatDuration(cell.startedAt, cell.endedAt);
  return `${formatTime(cell.startedAt)}${took ? ` · ${took}` : ''}${attempt}`;
}

/** Map a stage's status onto the header dot. */
export function dotFor(cell: StepperCell): InsideDot {
  switch (cell.status) {
    case 'passed':
      return 'done';
    case 'running':
      return 'run';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'idle';
    default:
      return 'pend';
  }
}

/** Assemble one stage's strip, defaulting the parts every stage shares. */
export function inside(
  cell: StepperCell,
  now: string,
  ops: StageOp[],
  dot?: InsideDot,
): StageInside {
  return {
    stageKey: cell.stageKey,
    title: STAGE_TITLES[cell.stageKey],
    dot: dot ?? dotFor(cell),
    clock: formatClock(cell, now),
    ops,
    blurb: STAGE_BLURBS[cell.stageKey],
  };
}
