import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import { collapseDiagnostic } from '../diagnosticText.js';
import { executionView, type SessionConfiguredInput } from './agent.js';
import { bounded } from './bounds.js';
import {
  formatDuration,
  formatExactDuration,
  formatTime,
  STAGE_TITLES,
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

/**
 * How one round's state reads. `interrupted` is a crash, not a verdict.
 *
 * `revalidating` is ACTIVE work, not a wait: the `stage fix pass` marker moved
 * the ticket back to the gate stage and the driver is re-running its gates
 * right now (the copy below even says "revalidation is running"). It renders
 * the same spinner as `fixing` — an amber pause ("needs you", UI-R28b) beside
 * running gates is the exact contradiction this mapping must never draw.
 */
function roundStatus(round: RecoveryRound): InsideStatus {
  switch (round.status) {
    case 'pending':
    case 'fixing':
    case 'revalidating':
      return 'run';
    case 'passed':
      return 'pass';
    case 'interrupted':
    case 'reset':
      return 'note';
    case 'failed':
    case 'exhausted':
    case 'refused':
      return 'fail';
  }
}

/** The cause of a round as prose — handoff §11's "UAT test failure" reading. */
function triggerProse(round: RecoveryRound): string {
  switch (round.triggerKind) {
    case 'gate-failure':
      return `${STAGE_TITLES[round.sourceStage]} test failure`;
    case 'tester-verifier-failure':
      return 'UAT verifier failure';
    case 'blocking-tester-observations':
      return 'UAT blocking observations';
    case 'blocking-review-findings':
      return 'Review blocking findings';
    default:
      // A future trigger kind degrades to the recorded prose, never a blank.
      return collapseDiagnostic(round.triggerDetail, TRIGGER_DETAIL_MAX);
  }
}

/**
 * One round's state as the handoff §11 copy. `passed`/`failed`/`interrupted`
 * keep the recorded trigger detail — §11 has no templates for those states,
 * and the failed row's factual cause ("what failed") must not vanish.
 */
function roundDetail(round: RecoveryRound): string {
  switch (round.status) {
    case 'pending':
    case 'fixing':
      return `Fix started after ${triggerProse(round)} · round ${round.round} of ${round.maxRounds}`;
    case 'revalidating':
      return `Fix completed; ${STAGE_TITLES[round.sourceStage]} revalidation is running`;
    case 'exhausted':
      return `Recovery exhausted after ${round.maxRounds} ${round.maxRounds === 1 ? 'round' : 'rounds'}. Resolve the remaining failure manually.`;
    default:
      return `${collapseDiagnostic(round.triggerDetail, TRIGGER_DETAIL_MAX)} — max ${round.maxRounds}`;
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
  configured?: SessionConfiguredInput | null,
  // The owning stage's OWN current verdict (uat/review), never re-derived
  // from the round: a review-origin round can be left `failed` when its
  // revalidation was interrupted by an UNRELATED uat failure (openRecoveryRound
  // fails the old round and opens a new one attributed to the stage that
  // actually failed) — the round series then never revisits review, even
  // though the driver goes on to re-run and pass it normally. Without this,
  // the collapsed Fix row keeps reporting that stale `failed` round forever,
  // reading as a currently-blocking fix on a stage that has since passed.
  stagePassed?: boolean,
): RecoveryProcessView | null {
  if (rounds.length === 0) return null;
  const latest = rounds[rounds.length - 1]!;
  const fixRun = processRuns.find((r) => r.id === latest.fixProcessRunId);
  const status: InsideStatus = stagePassed === true ? 'pass' : roundStatus(latest);

  const boundedRows = bounded(
    rounds.map((round): EvidenceRow => {
      return {
        status: roundStatus(round),
        label: `round ${round.round}`,
        detail: roundDetail(round),
        ...(round.startedAt
          ? {
              time: formatTime(round.startedAt),
              duration: formatDuration(round.startedAt, round.endedAt ?? now),
              durationExact: formatExactDuration(round.startedAt, round.endedAt ?? now),
            }
          : {}),
      };
    }),
    RECOVERY_ROWS_LIMIT,
  );
  const rows = [...boundedRows.shown];
  if (boundedRows.remaining > 0) {
    rows.push({ status: 'note', label: 'more', detail: `+${boundedRows.remaining} more` });
  }

  // The COLLAPSED fix row is never silent (handoff §11 + §3.8): every state
  // names what is happening, the exhausted one states what to do.
  const detail =
    status === 'pass' && latest.status !== 'passed'
      ? `${STAGE_TITLES[latest.sourceStage]} passed on a later attempt — this round's own failure is history`
      : latest.status === 'exhausted'
        ? `Recovery exhausted after ${latest.maxRounds} ${latest.maxRounds === 1 ? 'round' : 'rounds'}. Resolve the remaining failure manually.`
        : latest.status === 'failed'
          ? 'the fix did not hold — the next round names the new cause'
          : latest.status === 'pending' || latest.status === 'fixing'
            ? `Fix started after ${triggerProse(latest)} · round ${latest.round} of ${latest.maxRounds}`
            : latest.status === 'revalidating'
              ? `Fix completed; ${STAGE_TITLES[latest.sourceStage]} revalidation is running`
              : latest.status === 'interrupted'
                ? 'the fix session ended before it was done — it can be resumed'
                : undefined;

  return {
    triggerProcessId: latest.sourceProcessId,
    process: {
      id: 'fix',
      kind: 'fix',
      label: 'Fix',
      status,
      ...(detail ? { detail } : {}),
      ...(fixRun?.startedAt
        ? {
            duration: formatDuration(fixRun.startedAt, fixRun.endedAt ?? now),
            durationExact: formatExactDuration(fixRun.startedAt, fixRun.endedAt ?? now),
            time: formatTime(fixRun.startedAt),
          }
        : {}),
      // The §11 identity order, the same one every other AI process uses: what
      // RAN, else what settings SAY will run, else the absence copy. Fix is an
      // AI process — it resumes the captured session — and showing no identity
      // at all made it the one AI row on the stage with no `AI` mark.
      ...(fixRun?.provider
        ? { execution: executionView(fixRun.provider, fixRun.model, fixRun.agentName) }
        : {}),
      // The configured fallback applies ONLY when no run was recorded at all.
      // A run that recorded no provider is identity ABSENCE, never the
      // configured default: what RAN decides, and here it said nothing — so
      // that case takes `identityNote` below instead. This mirrors
      // `aiProcessBase` in `gates.ts` exactly.
      ...(!fixRun && configured
        ? { configuredExecution: executionView(configured.provider, configured.model) }
        : {}),
      ...(fixRun && !fixRun.provider
        ? { identityNote: 'No historical execution identity recorded' }
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
