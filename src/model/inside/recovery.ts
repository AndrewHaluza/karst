import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import { collapseDiagnostic } from '../diagnosticText.js';
import { executionView } from './agent.js';
import { bounded } from './bounds.js';
import {
  formatDuration,
  type EvidenceRow,
  type InsideProcessView,
  type InsideStatus,
} from './types.js';

/**
 * The conditional Fix process — recovery attached to the stage it returns to.
 *
 * `fix` is not a stage a person visits; it is what a failing UAT/Review
 * evidence opened, so it is rendered as a process inserted CAUSALLY into the
 * stage's process list, immediately after the process whose evidence triggered
 * the round (`insertCausalFix`). Everything here reads the DURABLE round rows
 * (`recovery_rounds`): the cause and the budget were snapshotted atomically
 * with the failing verdict, so a manifest knob changed after the failure can
 * never rewrite what the round committed under.
 *
 * One fix row whatever the history holds — exhaustion is stated inside the
 * row's evidence, never as a second fix process.
 */

/** Cap on recovery rows before the remainder row takes over. */
const RECOVERY_ROWS_LIMIT = 8;

/** Cap on a round's trigger detail — untrusted gate/verifier prose. */
const TRIGGER_DETAIL_MAX = 200;

/** How one round's state reads. `interrupted` is a crash, not a verdict. */
function roundStatus(round: RecoveryRound): InsideStatus {
  switch (round.status) {
    case 'pending':
    case 'fixing':
      return 'run';
    case 'revalidating':
      return 'wait';
    case 'passed':
      return 'pass';
    case 'interrupted':
      return 'note';
    case 'failed':
    case 'exhausted':
      return 'fail';
  }
}

/**
 * The fix row for one inside stage: every round the stage recorded, oldest
 * first, plus the identity/duration of the fix execution when the round has
 * one attached. Null when the stage recorded NO round — a fix row without
 * recovery evidence would be a promise, not a fact.
 */
export interface RecoveryProcessView {
  /** The process whose evidence opened the LATEST round — where Fix goes. */
  triggerProcessId: string;
  process: InsideProcessView;
}

export function recoveryProcess(
  rounds: readonly RecoveryRound[],
  processRuns: readonly ProcessRun[],
  now: string,
): RecoveryProcessView | null {
  if (rounds.length === 0) return null;
  const latest = rounds[rounds.length - 1]!;
  const fixRun = processRuns.find((r) => r.id === latest.fixProcessRunId);

  const boundedRows = bounded(
    rounds.map((round): EvidenceRow => {
      const detail = `${collapseDiagnostic(round.triggerDetail, TRIGGER_DETAIL_MAX)} — max ${round.maxRounds}`;
      return {
        status: roundStatus(round),
        label: `round ${round.round}`,
        detail: round.status === 'exhausted' ? `${detail} — no fix attempts left` : detail,
      };
    }),
    RECOVERY_ROWS_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  return {
    triggerProcessId: latest.sourceProcessId,
    process: {
      id: 'fix',
      kind: 'fix',
      label: 'Fix',
      status: roundStatus(latest),
      ...(latest.status === 'exhausted'
        ? { detail: 'no fix attempts left' }
        : latest.status === 'failed'
          ? { detail: 'the fix did not hold — the next round names the new cause' }
          : {}),
      ...(fixRun?.startedAt
        ? { duration: formatDuration(fixRun.startedAt, fixRun.endedAt ?? now) }
        : {}),
      ...(fixRun?.provider
        ? { execution: executionView(fixRun.provider, fixRun.model) }
        : {}),
      evidence: { kind: 'recovery', rows },
    },
  };
}

/**
 * Place the fix process immediately after the process whose evidence opened
 * the round — the reader sees the trigger, then the recovery it caused. A
 * round whose trigger process is not in this stage's list appends the fix at
 * the end rather than inventing a position; a stage with no round is returned
 * unchanged (never a fix row without recovery evidence).
 */
export function insertCausalFix(
  processes: readonly InsideProcessView[],
  recovery: RecoveryProcessView | null,
): InsideProcessView[] {
  if (!recovery) return [...processes];
  const index = processes.findIndex((process) => process.id === recovery.triggerProcessId);
  return index < 0
    ? [...processes, recovery.process]
    : [...processes.slice(0, index + 1), recovery.process, ...processes.slice(index + 1)];
}
