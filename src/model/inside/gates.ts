import { REVIEW_GATES, UAT_GATES, type GateSpec } from '../../workflow/gates/scripts.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey } from '../types.js';
import { formatDuration, inside, type StageInside, type StageOp } from './types.js';

/**
 * The gate stages (uat, review) are the only stages that record per-step
 * evidence, because they are the only ones that ask the repo deterministic
 * questions. Everything here reads recorded rows or the static gate list — never
 * the artifact log, whose text format is not a data contract.
 */

/** How a gate is invoked, as a person would type it. */
function command(spec: GateSpec): string {
  return spec.args[0] === 'run' ? `npm run ${spec.script}` : `npm ${spec.args.join(' ')}`;
}

/**
 * The most recent invocation's rows for a stage.
 *
 * Chosen by the greatest `runAt` (ISO stamps sort lexicographically), NOT by
 * array position. Taking the last element would make this depend on the store
 * returning rows in insertion order, which no query contract guarantees — an
 * added index or a planner change could surface a stale run with no test
 * failing to say so.
 *
 * `attempt` cannot be used for this either: it only increments on failure, so a
 * fail-then-pass pair sits at the same attempt.
 */
function latestBatch(runs: readonly GateRun[], stageKey: StageKey): GateRun[] {
  const mine = runs.filter((r) => r.stageKey === stageKey);
  const latest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  return latest === null ? [] : mine.filter((r) => r.runAt === latest);
}

/**
 * One gate's row. A recorded null exit code is a `note`, never a pass: it means
 * the repo defines no such script, so karst had no question to ask and the gate
 * says nothing about the ticket either way.
 */
function gateOp(spec: GateSpec, run: GateRun | undefined, showPending: boolean): StageOp | null {
  const cmd = command(spec);
  if (!run) {
    // Worth naming before OR during the run — the gate list is static, so
    // "still to come" is a fact whether the stage is pending or live. On a
    // finished stage a missing row means the gates predate this record, and
    // inventing one would be a guess.
    return showPending ? { status: 'pending', name: spec.name, detail: cmd, duration: '' } : null;
  }
  const duration = formatDuration(run.startedAt, run.endedAt);
  if (run.exitCode === null) {
    return {
      status: 'note',
      name: spec.name,
      detail: `no "${spec.script}" script in package.json — nothing to run`,
      duration,
    };
  }
  return {
    status: run.exitCode === 0 ? 'pass' : 'fail',
    name: spec.name,
    detail: `${cmd} — exit ${run.exitCode}`,
    duration,
  };
}

function gateOps(
  specs: readonly GateSpec[],
  batch: readonly GateRun[],
  showPending: boolean,
): StageOp[] {
  return specs
    .map((spec) => gateOp(spec, batch.find((r) => r.gateName === spec.name), showPending))
    .filter((op): op is StageOp => op !== null);
}

export function reviewInside(
  cell: StepperCell,
  runs: readonly GateRun[],
  now: string,
): StageInside {
  const running = cell.status === 'running';
  const finished = cell.status === 'passed' || cell.status === 'failed';
  const ops = gateOps(REVIEW_GATES, latestBatch(runs, 'review'), running || cell.status === 'pending');

  // The diff is opened unconditionally, on both verdicts — so once the stage has
  // finished this is something karst observed, not something it expects. Before
  // the stage starts, nothing has opened and nothing is promised yet, so no row.
  // A finished stage with no gate rows of its own (e.g. rows belonging to
  // another stage) has no evidence to hang a diff row on either.
  if (running || (finished && ops.length > 0)) {
    ops.push(
      running
        ? {
            status: 'note',
            name: 'diff',
            detail: 'opens for you when the gate finishes, pass or fail',
            duration: '',
          }
        : { status: 'pass', name: 'diff', detail: 'opened for review', duration: '' },
    );
  }

  return inside(cell, now, ops);
}

export function uatInside(cell: StepperCell, runs: readonly GateRun[], now: string): StageInside {
  const showPending = cell.status === 'running' || cell.status === 'pending';
  const ops = gateOps(UAT_GATES, latestBatch(runs, 'uat'), showPending);
  return inside(cell, now, ops);
}
