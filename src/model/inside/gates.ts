import type { GateRun } from '../../store/gateRuns.js';
import type { Finding } from '../../store/reviewFindings.js';
import { collapseDiagnostic } from '../diagnosticText.js';
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
export function latestBatch(runs: readonly GateRun[], stageKey: StageKey): GateRun[] {
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
    // The row states the gate's name and its exit code. `gate_runs` also
    // carries the argv that produced it now (`run.command`/`run.args`, v21),
    // but this summary line stays terse on purpose.
    detail: run.exitCode === null ? 'nothing to run' : `exit ${run.exitCode}`,
    duration: formatDuration(run.startedAt, run.endedAt),
  };
}

/**
 * The gate rows of one batch, or — before any row exists on a stage that is
 * plainly doing something — the fact that the list is not knowable yet. A
 * finished stage with no rows shows nothing: those gates predate this record,
 * and a pending row on a passed stage would be a false promise.
 *
 * Never shown once the stage is blocked: the block row states the reason
 * nothing ran, and pairing it with the generic "resolved per repository"
 * filler would say the same thing twice with different confidence.
 */
function recordedOps(batch: readonly GateRun[], cell: StepperCell): StageOp[] {
  const ops = batch.filter((r) => r.gateName !== CHANGES_GATE).map(gateOp);
  if (
    ops.length === 0 &&
    !cell.blocked &&
    (cell.status === 'running' || cell.status === 'pending')
  ) {
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

/**
 * The row naming why a blocked stage could not ask its question — fail-styled
 * because a park is not progress, even though it consumed no attempt.
 */
function blockedOp(blocked: NonNullable<StepperCell['blocked']>): StageOp {
  return {
    status: 'fail',
    name: 'blocked',
    detail: blocked.reason,
    duration: '',
  };
}

/**
 * A gate stage's rows: whatever evidence ran, plus the block row when the
 * stage is currently parked. Shared by both gate stages (`review`, `uat`) —
 * both commit through `commitGateOutcome` and both can park.
 */
function gateOps(cell: StepperCell, runs: readonly GateRun[], stageKey: StageKey): StageOp[] {
  const ops = recordedOps(latestBatch(runs, stageKey), cell);
  return cell.blocked ? [...ops, blockedOp(cell.blocked)] : ops;
}

/**
 * The most recently recorded findings batch — the same greatest-`runAt`
 * reduction `latestBatch` (above) documents for `gate_runs`, applied to
 * `review_findings` rows. Duplicated rather than imported from
 * `store/reviewFindings.ts`'s own `latestFindingBatch` for the same reason
 * that function gives for not sharing this one: the store layer must not
 * depend on `model/`, so each side keeps its own copy of a selection rule
 * simple enough that drift between them would be caught by either module's
 * own tests.
 */
function latestFindingsBatch(findings: readonly Finding[]): Finding[] {
  const latest = findings.reduce<string | null>(
    (max, f) => (max === null || f.runAt > max ? f.runAt : max),
    null,
  );
  return latest === null ? [] : findings.filter((f) => f.runAt === latest);
}

/** Findings at or above this severity read as fail-styled — they are the ones that can fail the ticket. */
const BLOCKING_STATUS_SEVERITIES: ReadonlySet<Finding['severity']> = new Set(['critical', 'high']);

/** Cap on a finding row's rendered detail — a list row, not a log line. */
const FINDING_DETAIL_MAX = 200;

/**
 * One finding as a row. `title`/`detail` are untrusted agent text — collapsed
 * to one line and capped here even though `parseFindings` already did it once
 * at the write-time boundary (`workflow/review/findings.ts`), the same
 * defense-in-depth `model/stepper.ts` applies to `verdict`/`blocked.reason`:
 * this render boundary must not depend on an earlier one having run.
 *
 * `repo` is deliberately not shown per-row — every row here already belongs
 * to one ticket's one review run, and `file` (when present) is the more
 * useful location.
 */
function findingOp(finding: Finding): StageOp {
  const location = finding.file
    ? finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file
    : null;
  const title = collapseDiagnostic(finding.title, FINDING_DETAIL_MAX);
  return {
    status: BLOCKING_STATUS_SEVERITIES.has(finding.severity) ? 'fail' : 'note',
    name: finding.severity,
    detail: location ? `${title} — ${location}` : title,
    duration: '',
  };
}

export function reviewInside(
  cell: StepperCell,
  runs: readonly GateRun[],
  findings: readonly Finding[],
  now: string,
): StageInside {
  const running = cell.status === 'running';
  const finished = cell.status === 'passed' || cell.status === 'failed';
  const batch = latestBatch(runs, 'review');
  const ops = gateOps(cell, runs, 'review');

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
  //
  // Skipped entirely while blocked: the block row already states why the
  // panel has not opened, and "opens when the gate finishes" would promise a
  // finish the park just refused to reach.
  const changesRun = batch.find((r) => r.gateName === CHANGES_GATE);
  if (!cell.blocked) {
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

    // Findings are review's own evidence, visible on the same terms as its
    // gate rows and the changes row above — I2 (spec §6.6): before this, a
    // finding was read only by the fix brief and `karst context`, never
    // rendered anywhere a human looks. Skipped while blocked for the same
    // reason the changes row is: a park already states why nothing ran, and a
    // stale prior-attempt finding rendered beside it would read as fresh
    // evidence about a run that never happened.
    ops.push(...latestFindingsBatch(findings).map(findingOp));
  }

  return inside(cell, now, ops);
}

export function uatInside(cell: StepperCell, runs: readonly GateRun[], now: string): StageInside {
  return inside(cell, now, gateOps(cell, runs, 'uat'));
}
