import type { ProcessRun } from '../../store/processRuns.js';
import type { WorktreeView } from '../../store/dashboard.js';
import { displayStatus, type StepperCell } from '../stepper.js';
import {
  formatDuration,
  formatExactDuration,
  formatTime,
  type EvidenceRow,
  type InsideProcessView,
  type InsideStatus,
} from './types.js';
import { bounded } from './bounds.js';
import { reviewProcesses, uatProcesses } from './gates.js';
import { insertCausalFix, recoveryProcess } from './recovery.js';
import { shipProcesses } from './ship.js';
import { doneReceipt } from './done.js';
import {
  executionView,
  implementationSessionProcess,
  tokenView,
  type SessionConfiguredInput,
  type SessionTokensInput,
  type SessionView,
} from './agent.js';

export { bounded } from './bounds.js';
export type { SessionConfiguredInput, SessionTokensInput } from './agent.js';
export { implementationSessionProcess } from './agent.js';
export { uatProcesses, reviewProcesses } from './gates.js';
export type { QualityProcessesInput } from './gates.js';
export { insertCausalFix, recoveryProcess } from './recovery.js';
export type { RecoveryProcessView } from './recovery.js';
export { shipProcesses } from './ship.js';
export type { ShipProcessesInput } from './ship.js';
export { doneReceipt } from './done.js';
export type { DoneReceiptInput, DoneReceiptView } from './done.js';

/** The number of per-worktree detail rows one scope process row shows. */
const WORKTREE_DETAIL_LIMIT = 8;

/**
 * Map a stage's status onto the process vocabulary. Read through `displayStatus`:
 * a parked stage keeps its stored `running` while blocked, and must never draw
 * a spinner — it reads `wait` (the amber two-bars glyph), like every other
 * "karst is waiting" row.
 */
function stageProcessStatus(cell: StepperCell): InsideStatus {
  switch (displayStatus(cell)) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'running':
      return 'run';
    case 'blocked':
      return 'wait';
    case 'skipped':
      return 'skip';
    default:
      return 'pending';
  }
}

/** The latest invocation of the prefill process, by its explicit run id. */
function latestPrefillRun(runs: readonly ProcessRun[]): ProcessRun | undefined {
  let best: ProcessRun | undefined;
  for (const run of runs) {
    if (run.processId !== 'prefill') continue;
    if (best === undefined || run.id > best.id) best = run;
  }
  return best;
}

/**
 * The prefill process (Task 10b): the AI analysis the ticket form ran when the
 * ticket was created — the coupled prompt/approach/repos/type prefill. It is
 * the scope stage's FIRST process, and it is the only scope process with an AI
 * identity: the run snapshots the provider that analyzed, and the token pill
 * states the recorded spend.
 *
 * Absent until an analysis actually ran — a ticket whose form never asked the
 * analyzer has no prefill row, because absence-by-omission beats inventing a
 * process that never happened. A run the analyzer closed as a failure reads as
 * one, never as a pass.
 */
function prefillProcess(
  runs: readonly ProcessRun[],
  tokens: SessionTokensInput | null | undefined,
  now: string,
): InsideProcessView | null {
  const run = latestPrefillRun(runs);
  if (!run) return null;
  const status: InsideStatus =
    run.status === 'passed'
      ? 'pass'
      : run.status === 'running'
        ? 'run'
        : run.status === 'failed'
          ? 'fail'
          : 'note';
  return {
    id: 'prefill',
    kind: 'prefill',
    label: 'Ticket analysis',
    status,
    detail:
      status === 'pass'
        ? 'prompt prefilled · approach, repos and type suggested'
        : status === 'run'
          ? 'analyzing the ticket prompt'
          : status === 'fail'
            ? 'analysis failed — the prompt was not prefilled'
            : 'analysis interrupted — no outcome',
    ...(run.startedAt
      ? {
          duration: formatDuration(run.startedAt, run.endedAt ?? now),
          durationExact: formatExactDuration(run.startedAt, run.endedAt ?? now),
          time: formatTime(run.startedAt),
        }
      : {}),
    ...(run.provider ? { execution: executionView(run.provider, run.model) } : {}),
    ...(tokens ? { tokens: tokenView(tokens) } : {}),
    evidence: { kind: 'rows', rows: [] },
  };
}

/**
 * Scope's process rows, in `INSIDE_PROCESSES.scope` order: the AI `prefill`
 * (when an analysis ran), `hot-set`, then `worktrees`. The hot set is ONE row
 * whatever the repo count — the count rides on it, never as a row per repo —
 * and the worktrees are one row whose evidence lists each created worktree,
 * bounded.
 *
 * The process runs are OPTIONAL (the prefill row appears only when one was
 * recorded): a caller that has not loaded them passes nothing and gets the
 * two scope rows every scope view has always had.
 */
export function scopeProcesses(
  cell: StepperCell,
  selectedRepos: readonly string[],
  worktrees: readonly WorktreeView[],
  now: string,
  processRuns?: readonly ProcessRun[],
  tokens?: SessionTokensInput | null,
): InsideProcessView[] {
  const count = selectedRepos.length;
  const ran = cell.status !== 'pending';
  const rowTime = (at: string | null | undefined): string =>
    at ? formatTime(at) : '';

  const hotSet: InsideProcessView = {
    id: 'hot-set',
    kind: 'hot-set',
    label: 'Hot set',
    status: stageProcessStatus(cell),
    count: String(count),
    detail:
      count === 1
        ? `1 service ${ran ? 'validated' : 'to validate'} against the manifest`
        : `${count} services ${ran ? 'validated' : 'to validate'} against the manifest`,
    ...(cell.startedAt
      ? {
          duration: formatDuration(cell.startedAt, cell.endedAt ?? now),
          durationExact: formatExactDuration(cell.startedAt, cell.endedAt ?? now),
          time: formatTime(cell.startedAt),
        }
      : {}),
    // The hot set's evidence is WHICH services it names. Without it the row
    // stated a count and offered no way to read the list behind it — the one
    // process on the stage whose whole content is an enumeration.
    evidence: {
      kind: 'rows',
      rows: selectedRepos.map(
        (repo): EvidenceRow => ({
          status: ran ? 'pass' : 'pending',
          label: repo,
          detail: ran ? 'selected' : 'to validate',
          // Each row dates from the scope run that selected it — the stage's
          // own start; there is no per-repo selection stamp.
          ...(ran && cell.startedAt ? { time: rowTime(cell.startedAt) } : {}),
        }),
      ),
    },
  };

  const boundedRows = bounded(
    worktrees.map(
      (w): EvidenceRow => {
        // The worktree's own registration stamp when the record has one; the
        // scope stage's start is the fallback for pre-v13 rows. An absent
        // stamp omits the time entirely — never an empty cell.
        const time = rowTime(w.createdAt ?? cell.startedAt);
        return {
          status: 'pass',
          label: 'worktree',
          detail: w.branch ? `${w.repoDisplay} · ${w.branch}` : w.repoDisplay,
          ...(time ? { time } : {}),
        };
      },
    ),
    WORKTREE_DETAIL_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  const prefill = prefillProcess(processRuns ?? [], tokens, now);
  return [
    ...(prefill ? [prefill] : []),
    hotSet,
    {
      id: 'worktrees',
      kind: 'worktrees',
      label: 'Worktrees',
      status:
        worktrees.length > 0
          ? stageProcessStatus(cell)
          : ran
            ? 'note'
            : 'pending',
      // The row's description in EVERY state (869egdr2u-fu1): the count of
      // created worktrees once scope ran, the "not created yet" answer before
      // it — never an empty detail cell.
      ...(worktrees.length > 0
        ? {
            detail:
              worktrees.length === 1
                ? '1 worktree created'
                : `${worktrees.length} worktrees created`,
            count: String(worktrees.length),
          }
        : ran
          ? { detail: 'no worktrees created' }
          : { detail: 'not created yet' }),
      // The row dates from the same scope run as the hot set — every scope
      // process carries its stamp (869egdr2u-fu1).
      ...(cell.startedAt
        ? {
            duration: formatDuration(cell.startedAt, cell.endedAt ?? now),
            durationExact: formatExactDuration(cell.startedAt, cell.endedAt ?? now),
            time: formatTime(cell.startedAt),
          }
        : {}),
      evidence: { kind: 'rows', rows },
    },
  ];
}

