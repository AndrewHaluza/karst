import type { GateRun } from '../../store/gateRuns.js';
import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import type { Finding } from '../../store/reviewFindings.js';
import type { UatFinding } from '../../store/uatFindings.js';
import { scopeReviewFindings } from '../findingScope.js';
import { collapseDiagnostic } from '../diagnosticText.js';
import { sortBySeverityDesc } from '../severityOrder.js';
import { displayStatus, type StepperCell } from '../stepper.js';
import type { StageKey } from '../types.js';
import { executionView, tokenView, type SessionConfiguredInput, type SessionTokensInput } from './agent.js';
import { bounded } from './bounds.js';
import { insertCausalFix, recoveryProcess } from './recovery.js';
import {
  batchForAttempt,
  latestAttemptKey,
  processRunForAttempt,
  roundsForAttempt,
  type AttemptKey,
} from './rounds.js';
import type { InsideEvidenceTarget, TypedInsideAction } from './types.js';
import {
  formatDuration,
  formatExactDuration,
  formatTime,
  insideSeverity,
  type EvidenceRow,
  type InsideProcessView,
  type InsideStatus,
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
 * Whether a selection names a SETTLED (non-latest) attempt (T3).
 *
 * `null`/absent is never settled — that is the un-looped "latest" path every
 * existing reducer already reproduces exactly. An explicit key is settled
 * unless it happens to name the newest recorded batch: a reader who selects
 * the tab already labelled `latest`/`live` still sees the live picture, not a
 * frozen one. A key that matches no recorded batch (a stale selection, or an
 * attempt whose rows never carried this stage's gates) is settled too — there
 * is nothing live left for it to be.
 */
function isSettledSelection(
  runs: readonly GateRun[],
  stageKey: StageKey,
  selectedAttempt: AttemptKey | null,
): boolean {
  if (selectedAttempt === null) return false;
  // Asked of the attempt SERIES, never of a row picked out of a batch: rows of
  // one batch need not agree about `stageRunId` (a legacy row carries none),
  // so `batch[0]` could name a key no attempt holds and make the newest
  // attempt read as settled.
  return selectedAttempt !== latestAttemptKey(runs, stageKey);
}

/** Host-authored absence copy for an AI process whose selected attempt recorded no run. */
const NO_RUN_FOR_ATTEMPT_DETAIL = 'no recorded run for this attempt';

/**
 * One recorded gate as a row.
 *
 * Three distinct outcomes, and the difference between the last two is the whole
 * point of the `skipped` column: `exitCode` 0/non-zero is a verdict; a null exit
 * with `skipped` false means the repo defines no such script, so karst had no
 * question to ask; a null exit with `skipped` true means the gate was there and
 * the user switched it off for this ticket. Neither of the last two is a pass.
 *
 * The `name` column is the gate's COMMAND name only: `gate_runs` records the
 * repo-decorated name ("test (web)", "lint (/wt/web)") so a gate of the same
 * name in two repos stays distinct, but the repo is ALREADY the row's first
 * column — repeating it in brackets beside the command is the noise this
 * strips (the design's "service first column, remove brackets").
 */
function gateOp(run: GateRun): StageOp & { repo: string | null; durationExact: string } {
  if (run.skipped) {
    return {
      status: 'skip',
      name: stripRepoDecoration(run.gateName),
      detail: 'Skipped — disabled by user',
      duration: '',
      repo: run.repo,
      durationExact: '',
    };
  }
  return {
    status: run.exitCode === null ? 'note' : run.exitCode === 0 ? 'pass' : 'fail',
    name: stripRepoDecoration(run.gateName),
    // The row states the gate's name and its exit code. `gate_runs` also
    // carries the argv that produced it now (`run.command`/`run.args`, v21),
    // but this summary line stays terse on purpose.
    detail: run.exitCode === null ? 'nothing to run' : `exit ${run.exitCode}`,
    duration: formatDuration(run.startedAt, run.endedAt),
    repo: run.repo,
    durationExact: formatExactDuration(run.startedAt, run.endedAt),
  };
}

/**
 * The gate's bare name — everything before the repo decoration ` (…)` the
 * stage appended at record time (`uat.ts`/`review.ts`'s `${name} (${label})`).
 * A name with no suffix passes through untouched.
 */
function stripRepoDecoration(name: string): string {
  return name.replace(/\s+\([^)]*\)$/, '');
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
 *
 * The location is returned SEPARATELY rather than folded into `detail`: it is
 * the resource identifier, so it is the row's link (UI-R09c), and a link
 * cannot be cut out of a sentence the webview is forbidden to parse.
 */
function findingOp(finding: Finding): StageOp & { location: string | null } {
  const title = collapseDiagnostic(finding.title, FINDING_DETAIL_MAX);
  return {
    status: BLOCKING_STATUS_SEVERITIES.has(finding.severity) ? 'fail' : 'note',
    name: finding.severity,
    detail: title,
    duration: '',
    location: findingLocation(finding.file, finding.line),
  };
}

/**
 * `path/to/file.ts:302` — the form the design asks the row to show and open.
 * A finding with no file names no location; a file with no line names the
 * file alone, because a fabricated `:0` would open the wrong place.
 */
function findingLocation(
  file: string | null | undefined,
  line: number | null | undefined,
): string | null {
  if (!file) return null;
  return line ? `${file}:${line}` : file;
}

/**
 * The quality stages' PROCESS reducers (Task 11): `uatProcesses` and
 * `reviewProcesses` emit the stage's processes in `INSIDE_PROCESSES` order and
 * insert the conditional Fix causally, immediately after the process whose
 * evidence opened the recovery round.
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
  /**
   * The round switcher's current selection (Option B, T3) — an `AttemptKey`
   * from `rounds.ts`'s `listGateAttempts`, or `null`/absent for "the latest
   * attempt", which reproduces every reducer's pre-switcher behaviour
   * BYTE-FOR-BYTE. Selecting a key re-derives the gate batch, the AI process
   * run, and that run's findings/observations from THAT attempt alone — never
   * a mix of one attempt's gates with another's findings.
   */
  selectedAttempt?: AttemptKey | null;
  /** The configured AI assignment — shown only before a recorded execution. */
  configured?: SessionConfiguredInput | null;
  /** A RECORDED token summary for the stage's AI process; omitted when unmeasured. */
  tokens?: SessionTokensInput | null;
  /**
   * Mint an opaque action for an evidence row, or return undefined when the
   * caller attaches none. Absent → rows carry no actions.
   */
  attach?: (target: InsideEvidenceTarget) => TypedInsideAction | undefined;
  /**
   * The gate names this stage WOULD run, resolved host-side
   * (`ui/dashboard/gateOptions.ts`) before anything has run. Optional: a panel
   * that has not resolved them yet passes nothing, and the row falls back to
   * stating that they resolve when the stage runs.
   */
  resolvedGates?: readonly { name: string; disabled: boolean }[];
  /**
   * The manifest repository NAME for a recorded repo value. `gate_runs.repo`
   * is a repository PATH, and a path is not what the settings call this thing
   * — the gate rows name the service the way Settings → Repositories names it,
   * exactly like the ship rows do. A repo the host cannot map falls back to
   * the raw recorded value rather than rendering nothing.
   */
  repoNameFor?: (repo: string) => string | undefined;
  /**
   * The findings repo scope for this stage — a recorded repo value
   * (`review_findings.repo` / `uat_findings.repo`, a repo PATH), or
   * `null`/absent for every repository. A value naming a repo the current
   * batch does not hold degrades to "all", the same way a stale attempt key
   * degrades to latest: never an empty body, never a throw.
   */
  findingsRepo?: string | null;
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
    ...(run?.startedAt
      ? {
          duration: formatDuration(run.startedAt, run.endedAt ?? now),
          durationExact: formatExactDuration(run.startedAt, run.endedAt ?? now),
          time: formatTime(run.startedAt),
        }
      : {}),
    ...(run?.provider ? { execution: executionView(run.provider, run.model, run.agentName) } : {}),
    // A run that recorded no provider is identity ABSENCE, never "unknown
    // identity" and never the configured default (handoff §11: "No historical
    // execution identity recorded" — what RAN decides, and here it says
    // nothing).
    ...(run && !run.provider ? { identityNote: 'No historical execution identity recorded' } : {}),
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
  resolved: readonly { name: string; disabled: boolean }[] = [],
  repoNameFor?: (repo: string) => string | undefined,
  processRuns: readonly ProcessRun[] = [],
  selectedAttempt: AttemptKey | null = null,
): InsideProcessView {
  // One mapping, used by BOTH the per-gate rows and the failure sentence: a
  // row that named the service while the summary above it named the path
  // would read as two different repositories.
  const repoLabel = (repo: string): string => repoNameFor?.(repo) ?? repo;
  const batch = batchForAttempt(runs, stageKey, selectedAttempt).filter(
    (r) => r.gateName !== CHANGES_GATE,
  );
  // A SETTLED (non-latest, or unmatched) selection can never be running,
  // waiting or blocked, and never forecasts gates that "would run": a past
  // attempt already happened, in full, or it did not happen at all — there is
  // no "so far" for it. `selectedAttempt === null` (the default/latest path)
  // is never settled, which is what keeps that path byte-for-byte unchanged.
  const settled = isSettledSelection(runs, stageKey, selectedAttempt);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of batch) {
    if (r.skipped) skipped += 1;
    else if (r.exitCode === null) continue;
    else if (r.exitCode === 0) passed += 1;
    else failed += 1;
  }

  // Read through `displayStatus`: `parkGateStage` leaves the status the runner
  // set, so a parked stage keeps reading `running` while blocked — it is not
  // running, and the row must not draw a spinner or promise the first gate's
  // row beside its own block banner.
  const shown = displayStatus(cell);
  // A settled attempt reads as finished no matter what the STAGE (the live
  // cell) is doing right now — the stage may well be running a LATER attempt,
  // but that says nothing about whether THIS one is still in flight.
  const finished = settled || shown === 'passed' || shown === 'failed';
  const running = !settled && shown === 'running';
  const blocked = !settled && shown === 'blocked';
  // Gates are only the stage's FIRST question. While the stage stays `running`
  // the gates process must not keep drawing a spinner after every gate has
  // answered: the stage is still running because its AI process (the Tester
  // for uat, the Review lane for review) is now the work in flight, and a
  // green batch beside the AI's spinner is what the stage is actually doing.
  // "The AI process has begun for THIS run" is proven by the AI process run
  // belonging to the SAME stage run as the recorded gate batch (`stageRunId`):
  // the AI only ever opens after the gates finish, and a run from a previous
  // attempt (or one the host died on — `stale`) carries a different stage run,
  // so it can never stand in for the current one. A batch with no recorded
  // row, or a stage run that predates the `stage_run_id` column, degrades to
  // the conservative answer: the gates are (still) running.
  const batchStageRunId = batch.length > 0 ? (batch[0]!.stageRunId ?? null) : null;
  const aiProcessId = stageKey === 'review' ? 'review' : 'tester';
  const aiRun = processRunForAttempt(processRuns, aiProcessId, selectedAttempt);
  const gatesDone =
    settled ||
    (batchStageRunId !== null &&
      aiRun !== undefined &&
      aiRun.stageRunId === batchStageRunId &&
      aiRun.status !== 'stale');
  // Before anything ran, the resolved names (`gateOptions.ts`) are the gates
  // that WOULD run — a forecast, ROWS ONLY: it never touches the counts or
  // the aggregate, because a gate that has not run has no outcome. Recorded
  // rows always win over the forecast (a record is a fact; a resolution is a
  // prediction), and a running stage shows no forecast either — its first
  // real row lands as the first gate finishes. A blocked stage shows none
  // either: nothing is about to run.
  const forecast =
    batch.length === 0 && !finished && !running && !blocked && resolved.length > 0;
  const boundedRows = bounded(
    forecast
      ? resolved.map((g): EvidenceRow => ({
          status: g.disabled ? 'skip' : 'pending',
          label: g.name,
          detail: g.disabled ? 'disabled for this ticket' : 'will run when the stage runs',
        }))
      : batch.map((r): EvidenceRow => {
          const op = gateOp(r);
          return {
            status: op.status,
            label: op.name,
            detail: op.detail,
            duration: op.duration,
            ...(op.repo ? { repo: repoLabel(op.repo) } : {}),
            ...(op.durationExact ? { durationExact: op.durationExact } : {}),
            // Each recorded gate row dates from its own start — the
            // timestamp on every expanded row.
            ...(r.startedAt ? { time: formatTime(r.startedAt) } : {}),
          };
        }),
    GATES_EVIDENCE_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  // The description IS the count, per state (the design's "6 / 6 command gates
  // passed"). A skipped gate, or one whose script the repo does not define, is
  // in `m` and not in `n`: it was recorded and it answered nothing. A batch
  // with no recorded row is absence, never "0/0".
  const firstFailed = batch.find((r) => !r.skipped && r.exitCode !== null && r.exitCode !== 0);
  const answered = passed + failed;
  const where = (r: GateRun): string =>
    r.repo
      ? `${repoLabel(r.repo)} / ${stripRepoDecoration(r.gateName)}`
      : stripRepoDecoration(r.gateName);
  let detail: string | undefined;
  let count: string | undefined;
  if (batch.length > 0 && failed === 0 && answered > 0) {
    detail = `${answered}/${batch.length} command gates passed`;
    count = answered === batch.length ? String(batch.length) : `${answered}/${batch.length}`;
  } else if (failed > 0 && firstFailed) {
    detail = `attempt ${cell.attempt ?? 0} failed · ${where(firstFailed)}`;
    count = `${passed}/${batch.length}`;
  } else if (running && !gatesDone && batch.length > 0) {
    // "so far" only while a gate is genuinely still in flight — a batch whose
    // AI has begun is finished, and `answered === 0` below reads as nothing to
    // run rather than as a promise of more gates.
    detail = `${answered}/${batch.length} command gates passed so far`;
    count = `${answered}/${batch.length}`;
  } else if (batch.length > 0 && answered === 0) {
    // Recorded and answered nothing (every gate's script is missing, or every
    // gate is disabled) — the n/m reading stays, never absence.
    detail = `${answered}/${batch.length} answered · nothing to run`;
  }
  // The process's duration: earliest recorded gate start → latest gate end
  // (or now, while one is running). No row with a start → no duration.
  let firstStart: string | undefined;
  let lastEnd: string | undefined;
  for (const r of batch) {
    if (!r.startedAt) continue;
    if (firstStart === undefined || r.startedAt < firstStart) firstStart = r.startedAt;
    const end = r.endedAt ?? now;
    if (lastEnd === undefined || end > lastEnd) lastEnd = end;
  }
  return {
    id: 'gates',
    kind: 'gates',
    label: 'Gates',
    status:
      batch.length === 0
        ? finished
          ? 'note'
          : blocked
            ? 'wait'
            : // A running stage with nothing recorded YET is running, not
              // pending: the first gate's row lands only when that gate finishes,
              // so `pending` here left the row inert for the whole first gate —
              // exactly the window the user is watching.
              running
              ? 'run'
              : 'pending'
        : failed > 0
          ? 'fail'
          : running
            ? // A green recorded batch is done work; only a batch with a gate
              // still in flight (the AI has not begun) keeps the spinner.
              gatesDone
              ? 'pass'
              : 'run'
            : 'pass',
    // The description IS the count, per state (design copy: "6 / 6 command
    // gates passed", "attempt 2 failed · web / test"). The verbose failure
    // sentence is retired with it — the failing gate's row keeps the terse
    // exit-code detail, and this compact line says which gate at which attempt.
    ...(detail
      ? { detail }
      : batch.length === 0
        ? {
              detail: finished
                ? 'no gates recorded for this stage'
                : blocked
                  ? 'blocked — the gates did not run'
                  : running
                    ? 'running the first gate — each result lands here as it finishes'
                    : forecast
                      ? 'not run yet — these gates would run'
                      : 'resolved per repository when the stage runs',
          }
        : {}),
    ...(count ? { count } : {}),
    ...(firstStart
      ? {
          duration: formatDuration(firstStart, lastEnd),
          durationExact: formatExactDuration(firstStart, lastEnd),
          time: formatTime(firstStart),
        }
      : {}),
    evidence: { kind: 'gates', rows, passed, failed, skipped },
  };
}

/**
 * The services process: host-known read-only context. It contributes the
 * configured service names to the stage's picture and can never pass or fail —
 * there is no recorded row that would authorize a verdict. When the host
 * resolved no names, the cause is not knowable here (an unresolved manifest, a
 * repo outside the ticket's scope, a non-runnable repo), so the row says
 * "not checked" — it must never claim a manifest fact the reducer did not
 * read (B6).
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
        : 'not checked — no services reported for this ticket',
  };
}

/**
 * The repo scope control for a findings batch, plus the batch the control
 * resolves to. Chips come from the UNFILTERED batch; a row naming no
 * repository ('' or null) contributes no chip and shows only under "All".
 */
function scopeFindings<T extends { repo?: string | null }>(
  batch: readonly T[],
  requested: string | null | undefined,
): { rows: readonly T[]; filter?: { repos: readonly string[]; selected: string | null } } {
  const present: string[] = [];
  for (const f of batch) {
    const repo = f.repo ?? '';
    if (repo.length > 0 && !present.includes(repo)) present.push(repo);
  }
  if (present.length < 2) return { rows: batch };
  const selected = requested && present.includes(requested) ? requested : null;
  const rows = selected === null ? batch : batch.filter((f) => (f.repo ?? '') === selected);
  return { rows, filter: { repos: present, selected } };
}

/**
 * The Tester process (uat): the latest Tester run and ITS observations, by
 * process-run id — an observation from an older invocation is superseded
 * evidence, not this run's. Observations are advisory: they render as note
 * rows and can never pass or fail the process by themselves; the recorded
 * `resultKind` is what states the outcome.
 */
function testerProcess(input: QualityProcessesInput): InsideProcessView {
  const selectedAttempt = input.selectedAttempt ?? null;
  const run = processRunForAttempt(input.processRuns, 'tester', selectedAttempt);
  const observations = run
    ? input.uatFindings.filter((f) => f.processRunId === run.id)
    : [];
  const scoped = scopeFindings(observations, input.findingsRepo);
  const ordered = sortBySeverityDesc(scoped.rows);
  const boundedRows = bounded(
    // Rendered by the SAME blueprint the Review findings use — severity key,
    // title, linked location — because a reader must not have to learn which
    // stage they are looking at to read a level or open a file.
    ordered.map((f): EvidenceRow => {
      const location = findingLocation(f.filePath, f.line);
      const title = collapseDiagnostic(f.title, FINDING_DETAIL_MAX);
      return {
        status: 'note',
        label: f.severity,
        detail: title,
        ...(insideSeverity(f.severity) ? { severity: insideSeverity(f.severity)! } : {}),
        ...(location ? { location } : {}),
        ...(location
          ? actionFor(input.attach, {
              kind: 'open-file',
              evidence: { source: 'uat-finding', id: f.id },
            })
          : {}),
        ...(f.repo ? { repo: f.repo } : {}),
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
    failedResultKinds: ['verification-failed', 'unreadable-output'],
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
                : run.resultKind === 'unreadable-output'
                  ? 'output unreadable — no observations recorded'
                  : run.resultKind === 'execution-failed'
                    ? 'adapter execution failed'
                    : run.resultKind === 'interrupted'
                      ? 'interrupted — no outcome'
                      : undefined,
        }
      : // A key was explicitly selected (not the default/latest path) and no
        // run matched it — the T1 known limit: a legacy run with a null
        // `stageRunId` can never match an explicit key. This is ABSENCE, not
        // "unknown": it must never fall back to a different attempt's run,
        // which would attribute one attempt's evidence to another.
        selectedAttempt !== null
        ? { detail: NO_RUN_FOR_ATTEMPT_DETAIL }
        : {}),
    // The Tester's live output is console-observable whenever it has run: the
    // persisted tail (Task 13) is host-read on request. Host-derived, so the
    // webview renders the console button only for a run that actually happened.
    ...(run ? { console: true } : {}),
    // The SAME evidence kind the Review process emits: one blueprint renders
    // both stages' levels and locations, so `high` looks like `high` wherever
    // it is read. Observations are advisory, so nothing here blocks.
    evidence: { kind: 'findings', rows, blocking: 0 },
    ...(scoped.filter ? { repoFilter: scoped.filter } : {}),
  };
}

/**
 * The Review process (review): the latest Review run and the latest findings
 * batch. Blocking severities (critical/high) count on the evidence and read
 * as fail-styled rows — they are the ones that can fail the ticket — while
 * the recorded `resultKind` states whether they actually did.
 */
function reviewProcess(input: QualityProcessesInput): InsideProcessView {
  const selectedAttempt = input.selectedAttempt ?? null;
  const run = processRunForAttempt(input.processRuns, 'review', selectedAttempt);
  // Both paths key findings to the process run that recorded them. The default
  // path used to reduce over the whole ticket by greatest `runAt`, on the (once
  // true, now stale) premise that findings carry no run id — v27 added
  // `review_findings.process_run_id` and `recordFindings` populates it. Because
  // findings are append-only and a clean re-review writes NO batch, that
  // reduction re-rendered a fixed round's findings under a running re-review,
  // and counted them as blocking. `scopeReviewFindings` owns the rule,
  // including the pre-v27 fallback; see `model/findingScope.ts`.
  const batch =
    selectedAttempt === null
      ? scopeReviewFindings(input.findings, run)
      : run
        ? input.findings.filter((f) => f.processRunId === run.id)
        : [];
  // blocking is the process's aggregate for the whole stage, not for the
  // visible rows — computed from the UNFILTERED, UNBOUNDED batch.
  const blocking = batch.filter((f) => BLOCKING_STATUS_SEVERITIES.has(f.severity)).length;
  const scoped = scopeFindings(batch, input.findingsRepo);
  const ordered = sortBySeverityDesc(scoped.rows);
  const boundedRows = bounded(
    ordered.map((f): EvidenceRow => {
      const op = findingOp(f);
      return {
        status: op.status,
        label: op.name,
        detail: op.detail,
        ...(insideSeverity(f.severity) ? { severity: insideSeverity(f.severity)! } : {}),
        // The location is the row's own control; the "Open file" button it
        // replaces was a second, weaker way to reach the same place.
        ...(op.location ? { location: op.location } : {}),
        ...(op.location
          ? actionFor(input.attach, {
              kind: 'open-file',
              evidence: { source: 'review-finding', id: f.id },
            })
          : {}),
        ...(f.repo ? { repo: f.repo } : {}),
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
    // The Review process's live output is console-observable whenever it has
    // run: the persisted tail (Task 13) is host-read on request. Host-derived,
    // so the webview renders the console button only for a run that actually
    // happened.
    ...(run ? { console: true } : {}),
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
                : // handoff §11: an execution failure must never read as
                  // "no findings" — it names what failed and what to do.
                  run.resultKind === 'execution-failed'
                  ? 'Review execution failed: the agent did not return a result. Retry review.'
                  : run.resultKind === 'interrupted'
                    ? 'interrupted — no outcome'
                    : undefined,
        }
      : selectedAttempt !== null
        ? { detail: NO_RUN_FOR_ATTEMPT_DETAIL }
        : {}),
    evidence: { kind: 'findings', rows, blocking },
    ...(scoped.filter ? { repoFilter: scoped.filter } : {}),
  };
}

/**
 * The Fix row for ONE attempt of a gate stage.
 *
 * The rounds are scoped to the selected attempt (`roundsForAttempt`), so the
 * row reports the recovery THAT attempt opened and a live attempt that has
 * failed nothing yet gets no Fix row at all. The stage's own current verdict
 * only overrides an older round's failure on the LATEST attempt: on an earlier
 * tab the attempt's own round is the fact being read, and a later pass must not
 * rewrite it.
 */
function stageRecovery(
  input: QualityProcessesInput,
  stageKey: 'uat' | 'review',
): ReturnType<typeof recoveryProcess> {
  const selected = input.selectedAttempt ?? null;
  const latest = latestAttemptKey(input.gateRuns, stageKey);
  const isLatest = selected === null || selected === latest;
  return recoveryProcess(
    roundsForAttempt(input.rounds, stageKey, selected, latest),
    input.processRuns,
    input.now,
    input.configured,
    isLatest && displayStatus(input.cell) === 'passed',
  );
}

/** The uat stage's processes: gates, services, tester — plus a causal fix. */
export function uatProcesses(input: QualityProcessesInput): InsideProcessView[] {
  const processes = [
    gatesProcess(
      input.cell,
      input.gateRuns,
      'uat',
      input.now,
      input.resolvedGates ?? [],
      input.repoNameFor,
      input.processRuns,
      input.selectedAttempt ?? null,
    ),
    servicesProcess(input.cell, input.services),
    testerProcess(input),
  ];
  return insertCausalFix(processes, stageRecovery(input, 'uat'));
}

/** The review stage's processes: gates, services, review — plus a causal fix. */
export function reviewProcesses(input: QualityProcessesInput): InsideProcessView[] {
  const processes = [
    gatesProcess(
      input.cell,
      input.gateRuns,
      'review',
      input.now,
      input.resolvedGates ?? [],
      input.repoNameFor,
      input.processRuns,
      input.selectedAttempt ?? null,
    ),
    servicesProcess(input.cell, input.services),
    reviewProcess(input),
  ];
  return insertCausalFix(processes, stageRecovery(input, 'review'));
}
