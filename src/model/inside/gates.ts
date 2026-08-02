import type { GateRun } from '../../store/gateRuns.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey } from '../types.js';
import { formatDuration, inside, type StageInside, type StageOp } from './types.js';

/**
 * The gate stages (uat, review) are the only stages that record per-step
 * evidence, because they are the only ones that ask the repo deterministic
 * questions. Everything here reads recorded rows — never the artifact log, whose
 * text format is not a data contract, and never a static gate list: BOTH stages
 * now resolve their gates per repository at runtime (review from a package.json
 * probe, uat from that or `uat.gates`), so the recorded rows ARE the list.
 * Matching runtime rows against a constant shows every gate as pending forever
 * once the names carry their repository label.
 */

/**
 * The changes-surface row review records beside its gates. Evidence, but not a
 * gate: it never touched the verdict, so it is rendered separately and must not
 * appear among the gates that decided one.
 */
const CHANGES_GATE = 'changes';

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
 * One recorded gate as a row. A null exit code is a `note`, never a pass: it
 * means the repo defines no such script, so karst had no question to ask and the
 * gate says nothing about the ticket either way.
 */
function gateOp(run: GateRun): StageOp {
  return {
    status: run.exitCode === null ? 'note' : run.exitCode === 0 ? 'pass' : 'fail',
    name: run.gateName,
    // No command to quote: the row keeps the gate's name and its exit code, not
    // the argv that produced it.
    detail: run.exitCode === null ? 'nothing to run' : `exit ${run.exitCode}`,
    duration: formatDuration(run.startedAt, run.endedAt),
  };
}

/**
 * The gate rows of one batch, or — before any row exists on a stage that is
 * plainly doing something — the fact that the list is not knowable yet. A
 * finished stage with no rows shows nothing: those gates predate this record,
 * and a pending row on a passed stage would be a false promise.
 */
function recordedOps(batch: readonly GateRun[], cell: StepperCell): StageOp[] {
  const ops = batch.filter((r) => r.gateName !== CHANGES_GATE).map(gateOp);
  if (ops.length === 0 && (cell.status === 'running' || cell.status === 'pending')) {
    return [
      {
        status: 'pending',
        name: 'gates',
        detail: 'resolved per repository when the stage runs',
        duration: '',
      },
    ];
  }
  return ops;
}

export function reviewInside(
  cell: StepperCell,
  runs: readonly GateRun[],
  now: string,
): StageInside {
  const running = cell.status === 'running';
  const finished = cell.status === 'passed' || cell.status === 'failed';
  const batch = latestBatch(runs, 'review');
  const ops = recordedOps(batch, cell);

  // This row states what happened, never what review merely intended to do.
  // `openDiff` is an optional host dependency (`DriveTicketDeps.openDiff`) —
  // absent, it opens nothing — so the row is driven by a recorded 'changes'
  // gate_run, evidence written in the SAME append-only place as every other
  // gate row, alongside the review batch it belongs to. A live boolean on the
  // run's return value would read correctly for one render and then be gone on
  // the next window reload; this survives it, the same as every other row here.
  //
  // Named and worded as "changes", not "diff": the host implementation
  // reveals the ticket's Changes panel — it does not itself invoke
  // `vscode.diff` (that only fires once a human clicks a file row inside the
  // panel). Claiming "diff opened" here would assert a control the run never
  // performed, the exact defect this row exists to close.
  const changesRun = batch.find((r) => r.gateName === CHANGES_GATE);
  if (running) {
    ops.push({
      status: 'note',
      name: CHANGES_GATE,
      detail: 'the changes panel opens for you when the gate finishes, pass or fail',
      duration: '',
    });
  } else if (finished && changesRun) {
    ops.push({
      status: 'pass',
      name: CHANGES_GATE,
      detail: 'changes panel opened for review',
      duration: formatDuration(changesRun.startedAt, changesRun.endedAt),
    });
  }

  return inside(cell, now, ops);
}

export function uatInside(cell: StepperCell, runs: readonly GateRun[], now: string): StageInside {
  return inside(cell, now, recordedOps(latestBatch(runs, 'uat'), cell));
}
