import type { WorktreeView } from '../../store/dashboard.js';
import type { StepperCell } from '../stepper.js';
import {
  formatDuration,
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
  implementationSessionProcess,
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

/** Map a stage's status onto the process vocabulary. */
function stageProcessStatus(cell: StepperCell): InsideStatus {
  switch (cell.status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'running':
      return 'run';
    case 'skipped':
      return 'skip';
    default:
      return 'pending';
  }
}

/**
 * Scope's two process rows (Task 10), in `INSIDE_PROCESSES.scope` order:
 * `hot-set` first, then `worktrees`. The hot set is ONE row whatever the repo
 * count — the count rides on it, never as a row per repo — and the worktrees
 * are one row whose evidence lists each created worktree, bounded.
 */
export function scopeProcesses(
  cell: StepperCell,
  selectedRepos: readonly string[],
  worktrees: readonly WorktreeView[],
  now: string,
): InsideProcessView[] {
  const count = selectedRepos.length;
  const ran = cell.status !== 'pending';

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
    ...(cell.startedAt ? { duration: formatDuration(cell.startedAt, cell.endedAt ?? now) } : {}),
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
        }),
      ),
    },
  };

  const boundedRows = bounded(
    worktrees.map(
      (w): EvidenceRow => ({
        status: 'pass',
        label: 'worktree',
        detail: w.branch ? `${w.repoDisplay} · ${w.branch}` : w.repoDisplay,
      }),
    ),
    WORKTREE_DETAIL_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  return [
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
      ...(worktrees.length === 0 && ran ? { detail: 'no worktrees created' } : {}),
      evidence: { kind: 'rows', rows },
    },
  ];
}

