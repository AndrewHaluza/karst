import type { GateRun } from '../../store/gateRuns.js';
import type { PhaseMark } from '../../store/phaseMarks.js';
import type { WorktreeView, PrView } from '../../store/dashboard.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey } from '../types.js';
import { STAGE_KEYS } from '../types.js';
import { inside, type StageInside, type StageOp } from './types.js';
import { reviewInside, uatInside } from './gates.js';
import { implInside, fixInside, type SessionView } from './agent.js';

export type { StageInside, StageOp, OpStatus, InsideDot } from './types.js';

/**
 * Everything needed to say what happened inside each stage — all of it already
 * loaded by the caller, so this stays pure: no store, no clock, no vscode.
 */
export interface StageInsideInput {
  stepper: readonly StepperCell[];
  gateRuns: readonly GateRun[];
  worktrees: readonly WorktreeView[];
  prs: readonly PrView[];
  session: SessionView;
  /** The hot repo set the ticket was scoped to. */
  selectedRepos: readonly string[];
  /** The approach's DECLARED workflow phase names. Never per-phase state. */
  phases: readonly string[];
  /**
   * Every phase the agent REPORTED entering, for the whole ticket, oldest first.
   * Ungrouped by contract (`listPhaseMarks`): selecting the stage and attempt is
   * a pure decision, made in the model layer where it is testable without a DB.
   */
  marks: readonly PhaseMark[];
  fixAttempts: number;
  /** Injected so a running stage's elapsed time is testable. */
  now: string;
}

/**
 * Scope's evidence is the worktrees it created — the one thing it persists.
 * `scopeTicket`'s migration warnings are computed and discarded, so there is no
 * warning row to show and inventing one would be a guess.
 */
function scopeInside(
  cell: StepperCell,
  worktrees: readonly WorktreeView[],
  selectedRepos: readonly string[],
  now: string,
): StageInside {
  if (worktrees.length === 0) return inside(cell, now, []);

  const count = selectedRepos.length || worktrees.length;
  const ops: StageOp[] = [
    {
      status: 'pass',
      name: 'hot set',
      detail: `${count} ${count === 1 ? 'service' : 'services'} validated against the manifest`,
      duration: '',
    },
    ...worktrees.map((w): StageOp => ({
      status: 'pass',
      name: 'worktree',
      detail: w.branch ? `${w.repoDisplay} · ${w.branch}` : w.repoDisplay,
      duration: '',
    })),
  ];
  return inside(cell, now, ops);
}

/**
 * Ship's evidence is the PR rows it wrote, plus — on a failure — the real error
 * its catch stored on the stage. The individual commit/push/describe steps are
 * not recorded, so they are not claimed.
 */
function shipInside(cell: StepperCell, prs: readonly PrView[], now: string): StageInside {
  if (cell.status === 'failed') {
    return inside(cell, now, [
      {
        status: 'fail',
        name: 'ship',
        detail: cell.reason ?? 'failed with no reason recorded',
        duration: '',
      },
    ]);
  }
  const ops = prs.map((pr): StageOp => ({
    status: 'pass',
    name: 'pr',
    detail: pr.number ? `${pr.repo} #${pr.number}` : pr.repo,
    duration: '',
  }));
  return inside(cell, now, ops);
}

function stripFor(key: StageKey, cell: StepperCell, input: StageInsideInput): StageInside {
  switch (key) {
    case 'scope':
      return scopeInside(cell, input.worktrees, input.selectedRepos, input.now);
    case 'impl':
      return implInside(cell, input.session, input.phases, input.marks, input.now);
    case 'uat':
      return uatInside(cell, input.gateRuns, input.now);
    case 'review':
      return reviewInside(cell, input.gateRuns, input.now);
    case 'fix':
      return fixInside(cell, input.session.sessionId, input.fixAttempts, input.now);
    case 'ship':
      return shipInside(cell, input.prs, input.now);
    case 'done':
      // Terminal: the machine stamps started_at === ended_at, so the duration is
      // structurally zero and there is no step to report. Arriving IS the event.
      return inside(cell, input.now, []);
  }
}

/**
 * Precompute what happened inside every stage, so the panel can re-point at any
 * stage on click without a round trip to the host.
 */
export function buildStageInside(input: StageInsideInput): Record<StageKey, StageInside> {
  const byKey = new Map(input.stepper.map((c) => [c.stageKey, c]));
  const out = {} as Record<StageKey, StageInside>;
  for (const key of STAGE_KEYS) {
    out[key] = stripFor(key, byKey.get(key) ?? { stageKey: key, status: 'pending' }, input);
  }
  return out;
}
