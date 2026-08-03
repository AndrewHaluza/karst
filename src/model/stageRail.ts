import { MAIN_LINE, GATE_STAGES, STAGE_GRAPH } from '../workflow/graph.js';
import {
  FIX_ATTEMPT_CAP,
  countFixAttempts,
  lastFailedGate,
  type GateStageKey,
} from '../workflow/fixAttempts.js';
import type { RailNeeds } from './railNeeds.js';
import type { StepperCell } from './stepper.js';
import type { StageKey } from './types.js';

export type { RailNeeds };

/**
 * The fix loop, drawn on the gate it retries.
 *
 * `fix` is not a station. STAGE_GRAPH reaches it only by a failed verdict and its
 * only outgoing edge returns to `uat`, so nothing can ever be AFTER fix and the
 * ticket never leaves the failed gate's neighbourhood. Drawing it as a seventh
 * node bought permanent layout for a stage most tickets never enter, and left a
 * control on screen reading `fix idle` — a control announcing that nothing is
 * happening.
 *
 * Ticks, not a bar: a bar reads as progress toward completion, and spending fix
 * attempts is the opposite of progress.
 */
export interface RetryMeter {
  /** The gate whose budget this spends — the loop belongs to it, not to fix. */
  gate: GateStageKey;
  /** Attempts spent, PER GATE (never summed across uat and review). */
  spent: number;
  /** Attempts allowed for THIS gate — one tick each. */
  cap: number;
  /** The fix stage is running right now. A spent-but-idle meter is a record. */
  live: boolean;
  /**
   * Where the loop lands, when that is not the gate it left. Derived from the
   * graph, never written down: the shipped rail hardcoded `pass → review` and the
   * graph says `uat`. Null when the loop returns where it already is — returning
   * to where you are is not information.
   */
  returnsTo: StageKey | null;
}

/** One segment of the track: a stage, plus everything drawn inside it. */
export interface RailSegment {
  /** The stage's own row (status, reason, times, attempt). */
  cell: StepperCell;
  /** This is the stage the ticket sits at. Exactly one, or none. */
  current: boolean;
  /** The ticket is blocked on the user, HERE. Only ever the current segment. */
  needsUser: boolean;
  /** Host-rendered words for it; null unless `needsUser`. */
  needs: RailNeeds | null;
  /** The retry loop, on the gate that was retried; null everywhere else. */
  retry: RetryMeter | null;
}

/**
 * The stage graph as it is drawn: ONE object the ticket travels through.
 *
 * `fix` stays structurally absent from `main` — the reason the old `branch` field
 * existed still holds, and a flagged cell would make every consumer responsible
 * for filtering it, which is precisely how it ended up rendered as a linear step.
 * It just no longer needs a field of its own, because it is now drawn INSIDE the
 * gate it retries.
 */
export interface StageRail {
  main: RailSegment[];
}

export interface BuildRailOptions {
  /** `ticket.stageCurrent`. A stored string: it may name no main-line stage. */
  current: string | null;
  /** The ticket's existing needs-you derivation ([[ticketGlyph]]). */
  needsUser: boolean;
  /** The words for it ([[railNeeds]]), rendered host-side. */
  needs: RailNeeds | null;
  /**
   * The fix budget for one gate. Injected so the manifest's `uat.maxFixAttempts`
   * reaches the meter without this module reading a manifest; the default is the
   * graph's own cap, never a guess that would misreport the budget.
   */
  capFor?: (gate: GateStageKey) => number;
}

/** The stage rows this reads — the same loose shape the fix-attempt helpers take. */
type StageRows = readonly {
  stageKey: string;
  status?: string;
  endedAt?: string | null;
  attempt?: number;
}[];

/** A cell for a stage that has no row yet — the pre-run default. */
function pending(stageKey: StageKey): StepperCell {
  return { stageKey, status: 'pending' };
}

function cellFor(stepper: readonly StepperCell[], stageKey: StageKey): StepperCell {
  return stepper.find((c) => c.stageKey === stageKey) ?? pending(stageKey);
}

/**
 * Which gate the loop belongs to.
 *
 * `lastFailedGate` answers while a gate is SITTING failed, which is the live
 * case. Once it has been fixed and re-passed the row reads `passed` and it
 * answers null — but the gate's `attempt` still records what the ticket cost, and
 * that stays true after it goes green. So the spent attempts are the fallback,
 * and the deeper loop wins when both gates have one.
 */
function retriedGate(stages: StageRows): GateStageKey | null {
  const failed = lastFailedGate(stages);
  if (failed) return failed;

  const spent = GATE_STAGES.map((gate) => ({
    gate: gate as GateStageKey,
    n: countFixAttempts(stages, gate as GateStageKey),
  })).filter((x) => x.n > 0);
  if (spent.length === 0) return null;
  return spent.reduce((a, b) => (b.n > a.n ? b : a)).gate;
}

/** The meter for the gate that was retried, or null while the loop is untouched. */
function meterFor(
  stages: StageRows,
  fixRunning: boolean,
  capFor: (gate: GateStageKey) => number,
): RetryMeter | null {
  const gate = retriedGate(stages);
  if (!gate) return null;
  const spent = countFixAttempts(stages, gate);
  // Before the loop is entered there is nothing to report; a meter reading 0 of 3
  // would imply the ticket has already been round once.
  if (spent === 0) return null;

  const returnsTo = STAGE_GRAPH.fix.passed ?? null;
  return {
    gate,
    spent,
    cap: capFor(gate),
    live: fixRunning,
    returnsTo: returnsTo === gate ? null : returnsTo,
  };
}

/**
 * Split a flat stepper into the shape the track is drawn in.
 *
 * `buildStepper` keeps its canonical projection — that is correct, and the
 * ticket form relies on it. This is the dashboard's view on top of it.
 */
export function buildStageRail(
  stepper: readonly StepperCell[],
  stages: StageRows,
  opts: BuildRailOptions,
): StageRail {
  const capFor = opts.capFor ?? (() => FIX_ATTEMPT_CAP);
  const meter = meterFor(stages, cellFor(stepper, 'fix').status === 'running', capFor);

  return {
    main: MAIN_LINE.map((k): RailSegment => {
      const current = opts.current === k;
      // Needs-you belongs to the stage the ticket IS at. Painting it anywhere
      // else would claim a second place the user is wanted.
      const needsUser = current && opts.needsUser;
      return {
        cell: cellFor(stepper, k),
        current,
        needsUser,
        needs: needsUser ? opts.needs : null,
        retry: meter && meter.gate === k ? meter : null,
      };
    }),
  };
}
