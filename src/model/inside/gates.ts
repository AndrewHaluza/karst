import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { Finding } from '../../store/reviewFindings.js';
import type { UatFinding } from '../../store/uatFindings.js';
import { collapseDiagnostic } from '../diagnosticText.js';
import type { StepperCell } from '../stepper.js';
import type { StageKey } from '../types.js';
import { executionView, tokenView, type SessionConfiguredInput, type SessionTokensInput } from './agent.js';
import { bounded } from './bounds.js';
import { insertCausalFix, recoveryProcess } from './recovery.js';
import type { InsideEvidenceTarget, TypedInsideAction } from './types.js';
import {
  formatDuration,
  inside,
  type EvidenceRow,
  type InsideProcessView,
  type InsideStatus,
  type StageInside,
  type StageOp,
} from './types.js';

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
 * One recorded gate as a row.
 *
 * Three distinct outcomes, and the difference between the last two is the whole
 * point of the `skipped` column: `exitCode` 0/non-zero is a verdict; a null exit
 * with `skipped` false means the repo defines no such script, so karst had no
 * question to ask; a null exit with `skipped` true means the gate was there and
 * the user switched it off for this ticket. Neither of the last two is a pass.
 */
function gateOp(run: GateRun): StageOp {
  if (run.skipped) {
    return {
      status: 'skip',
      name: run.gateName,
      detail: 'Skipped — disabled by user',
      duration: '',
    };
  }
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

/**
 * The quality stages' PROCESS reducers (Task 11): `uatProcesses` and
 * `reviewProcesses` emit the stage's processes in `INSIDE_PROCESSES` order and
 * insert the conditional Fix causally, immediately after the process whose
 * evidence opened the recovery round. The flat `uatInside`/`reviewInside`
 * strips above stay for the legacy renderer; these produce the new
 * `InsideProcessView` model.
 *
 * Nothing here may infer a status: pass/run/fail requires a RECORDED row.
 * Pending config may describe gate names, services or the configured AI
 * assignment — it can never read as a verdict. Every selection is by explicit
 * invocation id (a run's id, a batch's stamp), never by array position.
 */

/** Cap on gate rows before the remainder row takes over. */
const GATES_EVIDENCE_LIMIT = 8;

/** Cap on finding rows before the remainder row takes over. */
const FINDINGS_EVIDENCE_LIMIT = 6;

/** Everything both quality stages' process reducers consume, already loaded. */
export interface QualityProcessesInput {
  cell: StepperCell;
  gateRuns: readonly GateRun[];
  /** Review findings — the review stage's evidence; empty for uat. */
  findings: readonly Finding[];
  /** Tester observations — the uat stage's advisory evidence; empty for review. */
  uatFindings: readonly UatFinding[];
  /** Every process run recorded for the ticket, ticket-wide. */
  processRuns: readonly ProcessRun[];
  /** Every recovery round recorded for the ticket; filtered to the stage here. */
  rounds: readonly RecoveryRound[];
  /** The manifest's service names — host-known read-only context, never a verdict. */
  services: readonly string[];
  /** Injected so a running process's elapsed time is testable. */
  now: string;
  /** The configured AI assignment — shown only before a recorded execution. */
  configured?: SessionConfiguredInput | null;
  /** A RECORDED token summary for the stage's AI process; omitted when unmeasured. */
  tokens?: SessionTokensInput | null;
  /**
   * Mint an opaque action for an evidence row, or return undefined when the
   * caller attaches none. Absent → rows carry no actions.
   */
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
}

/** The latest invocation of a process, by its explicit run id. */
function latestProcessRun(
  runs: readonly ProcessRun[],
  processId: string,
): ProcessRun | undefined {
  let best: ProcessRun | undefined;
  for (const run of runs) {
    if (run.processId !== processId) continue;
    if (best === undefined || run.id > best.id) best = run;
  }
  return best;
}

/**
 * A run's state as its process row reads. `interrupted` and `stale` are not
 * verdicts: a run that died without an outcome is a note, never a pass or a
 * fail. A `passed` run whose result kind names a deterministic failure
 * (`verification-failed` for the Tester) reads as a fail — the verdict came
 * from the recorded boundary, not from inference.
 */
function processRunStatus(run: ProcessRun, failedResultKinds: readonly string[]): InsideStatus {
  switch (run.status) {
    case 'running':
      return 'run';
    case 'passed':
      return failedResultKinds.includes(run.resultKind ?? '') ? 'fail' : 'pass';
    case 'failed':
      return 'fail';
    case 'interrupted':
    case 'stale':
      return 'note';
  }
}

/** The shared spine of the Tester/Review process rows. */
function aiProcessBase(
  cell: StepperCell,
  run: ProcessRun | undefined,
  configured: SessionConfiguredInput | null | undefined,
  tokens: SessionTokensInput | null | undefined,
  now: string,
  spec: { id: 'tester' | 'review'; label: string; failedResultKinds: readonly string[] },
): Omit<InsideProcessView, 'detail' | 'evidence'> {
  return {
    id: spec.id,
    kind: spec.id,
    label: spec.label,
    status: run
      ? processRunStatus(run, spec.failedResultKinds)
      : cell.status === 'pending'
        ? 'pending'
        : 'note',
    ...(run?.startedAt ? { duration: formatDuration(run.startedAt, run.endedAt ?? now) } : {}),
    ...(run?.provider ? { execution: executionView(run.provider, run.model) } : {}),
    ...(!run && configured
      ? { configuredExecution: executionView(configured.provider, configured.model) }
      : {}),
    ...(tokens ? { tokens: tokenView(tokens) } : {}),
  };
}

/** Attach a minted action to a row when the caller supplies an attacher. */
function actionFor(
  attach: QualityProcessesInput['attach'],
  target: InsideEvidenceTarget,
): { action: TypedInsideAction } | {} {
  const action = attach?.(target);
  return action ? { action } : {};
}

/**
 * The gates process: the latest recorded batch, counted and bounded. Rows
 * keep the flat renderer's distinctions — `skip` for a gate the user disabled,
 * `note` for one the repo cannot answer — and the counts are the WHOLE batch,
 * not the bounded subset.
 */
function gatesProcess(
  cell: StepperCell,
  runs: readonly GateRun[],
  stageKey: StageKey,
  now: string,
): InsideProcessView {
  const batch = latestBatch(runs, stageKey).filter((r) => r.gateName !== CHANGES_GATE);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of batch) {
    if (r.skipped) skipped += 1;
    else if (r.exitCode === null) continue;
    else if (r.exitCode === 0) passed += 1;
    else failed += 1;
  }

  const boundedRows = bounded(
    batch.map((r): EvidenceRow => {
      const op = gateOp(r);
      return { status: op.status, label: op.name, detail: op.detail, duration: op.duration };
    }),
    GATES_EVIDENCE_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  const finished = cell.status === 'passed' || cell.status === 'failed';
  return {
    id: 'gates',
    kind: 'gates',
    label: 'Gates',
    status:
      batch.length === 0
        ? finished
          ? 'note'
          : 'pending'
        : failed > 0
          ? 'fail'
          : cell.status === 'running'
            ? 'run'
            : 'pass',
    ...(batch.length === 0
      ? {
          detail: finished
            ? 'no gates recorded for this stage'
            : 'resolved per repository when the stage runs',
        }
      : {}),
    evidence: { kind: 'gates', rows, passed, failed, skipped },
  };
}

/**
 * The services process: host-known read-only context. It contributes the
 * configured service names to the stage's picture and can never pass or fail —
 * there is no recorded row that would authorize a verdict.
 */
function servicesProcess(cell: StepperCell, services: readonly string[]): InsideProcessView {
  return {
    id: 'services',
    kind: 'services',
    label: 'Services',
    status: cell.status === 'pending' ? 'pending' : 'note',
    detail:
      services.length > 0
        ? services.join(' · ')
        : 'no service blocks in the manifest — gates run against the worktrees',
  };
}

/**
 * The Tester process (uat): the latest Tester run and ITS observations, by
 * process-run id — an observation from an older invocation is superseded
 * evidence, not this run's. Observations are advisory: they render as note
 * rows and can never pass or fail the process by themselves; the recorded
 * `resultKind` is what states the outcome.
 */
function testerProcess(input: QualityProcessesInput): InsideProcessView {
  const run = latestProcessRun(input.processRuns, 'tester');
  const observations = run
    ? input.uatFindings.filter((f) => f.processRunId === run.id)
    : [];
  const boundedRows = bounded(
    observations.map((f): EvidenceRow => {
      const location = f.filePath ? (f.line ? `${f.filePath}:${f.line}` : f.filePath) : null;
      const title = collapseDiagnostic(f.title, FINDING_DETAIL_MAX);
      return {
        status: 'note',
        label: f.severity,
        detail: location ? `${title} — ${location}` : title,
        ...actionFor(input.attach, {
          kind: 'open-file',
          evidence: { source: 'uat-finding', id: f.id },
        }),
      };
    }),
    FINDINGS_EVIDENCE_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  const base = aiProcessBase(input.cell, run, input.configured, input.tokens, input.now, {
    id: 'tester',
    label: 'Tester',
    failedResultKinds: ['verification-failed'],
  });
  return {
    ...base,
    ...(run
      ? {
          detail:
            run.resultKind === 'observed'
              ? `${observations.length} observation${observations.length === 1 ? '' : 's'} — advisory`
              : run.resultKind === 'verification-failed'
                ? 'verifier failed — the observation did not hold'
                : run.resultKind === 'execution-failed'
                  ? 'adapter execution failed'
                  : run.resultKind === 'interrupted'
                    ? 'interrupted — no outcome'
                    : undefined,
        }
      : {}),
    evidence: { kind: 'rows', rows },
  };
}

/**
 * The Review process (review): the latest Review run and the latest findings
 * batch. Blocking severities (critical/high) count on the evidence and read
 * as fail-styled rows — they are the ones that can fail the ticket — while
 * the recorded `resultKind` states whether they actually did.
 */
function reviewProcess(input: QualityProcessesInput): InsideProcessView {
  const run = latestProcessRun(input.processRuns, 'review');
  const batch = latestFindingsBatch(input.findings);
  const blocking = batch.filter((f) => BLOCKING_STATUS_SEVERITIES.has(f.severity)).length;
  const boundedRows = bounded(
    batch.map((f): EvidenceRow => {
      const op = findingOp(f);
      return {
        status: op.status,
        label: op.name,
        detail: op.detail,
        ...actionFor(input.attach, {
          kind: 'open-file',
          evidence: { source: 'review-finding', id: f.id },
        }),
      };
    }),
    FINDINGS_EVIDENCE_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  const base = aiProcessBase(input.cell, run, input.configured, input.tokens, input.now, {
    id: 'review',
    label: 'Review',
    failedResultKinds: ['blocking'],
  });
  return {
    ...base,
    // The kind-specific aggregate (B4): the blocking count, worded per handoff
    // §6 ("2 blocking"). Host-computed from the same count the evidence
    // carries; omitted when nothing blocks rather than claiming "0".
    ...(blocking > 0 ? { aggregate: `${blocking} blocking` } : {}),
    ...(run
      ? {
          detail:
            run.resultKind === 'blocking'
              ? `${blocking} blocking finding${blocking === 1 ? '' : 's'}`
              : run.resultKind === 'validated'
                ? 'no blocking findings'
                : run.resultKind === 'execution-failed'
                  ? 'adapter execution failed'
                  : run.resultKind === 'interrupted'
                    ? 'interrupted — no outcome'
                    : undefined,
        }
      : {}),
    evidence: { kind: 'findings', rows, blocking },
  };
}

/** The uat stage's processes: gates, services, tester — plus a causal fix. */
export function uatProcesses(input: QualityProcessesInput): InsideProcessView[] {
  const processes = [
    gatesProcess(input.cell, input.gateRuns, 'uat', input.now),
    servicesProcess(input.cell, input.services),
    testerProcess(input),
  ];
  const stageRounds = input.rounds.filter((r) => r.sourceStage === 'uat');
  return insertCausalFix(processes, recoveryProcess(stageRounds, input.processRuns, input.now));
}

/** The review stage's processes: gates, services, review — plus a causal fix. */
export function reviewProcesses(input: QualityProcessesInput): InsideProcessView[] {
  const processes = [
    gatesProcess(input.cell, input.gateRuns, 'review', input.now),
    servicesProcess(input.cell, input.services),
    reviewProcess(input),
  ];
  const stageRounds = input.rounds.filter((r) => r.sourceStage === 'review');
  return insertCausalFix(processes, recoveryProcess(stageRounds, input.processRuns, input.now));
}
