import type { ProcessRun } from '../../store/processRuns.js';
import type { RecoveryRound } from '../../store/recoveryRounds.js';
import { collapseDiagnostic } from '../diagnosticText.js';
import { executionView, type SessionConfiguredInput } from './agent.js';
import { fixDeliveryNote, type FixDeliveryFacts } from './fixDeliveryNote.js';
import {
  formatDuration,
  formatExactDuration,
  formatTime,
  STAGE_TITLES,
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

/** A round plus the receipt state of its stored fix brief (@arch:V77), when it has one. */
export type RoundWithDelivery = RecoveryRound & { fixDelivery?: FixDeliveryFacts };

/** Cap on a round's trigger detail — untrusted gate/verifier prose. */
const TRIGGER_DETAIL_MAX = 200;

/**
 * How one round's state reads. `interrupted` is a crash, not a verdict.
 *
 * `revalidating` is the FIX's own completion: the `stage fix pass` marker moved
 * the ticket back to the gate stage, so the work THIS row reports is over and
 * the re-run belongs to the gate row of the attempt now running. It reads
 * `pass`, never a spinner — the spinner claimed a fix was still working on the
 * very attempt that had already finished it — and never an amber pause ("needs
 * you", UI-R28b) beside running gates, the other contradiction this mapping
 * must not draw.
 */
function roundStatus(round: RecoveryRound): InsideStatus {
  switch (round.status) {
    case 'pending':
    case 'fixing':
      return 'run';
    case 'revalidating':
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
export function triggerProse(round: RecoveryRound): string {
  switch (round.triggerKind) {
    case 'gate-failure':
      return `${STAGE_TITLES[round.sourceStage]} test failure`;
    case 'tester-verifier-failure':
      return 'UAT verifier failure';
    case 'blocking-tester-observations':
      return 'UAT blocking observations';
    case 'blocking-review-findings':
      return 'Review blocking findings';
    case 'usage-limit-dismissed':
      // D159: a dismissed usage-limit park opens a recovery round; the cause is
      // the dismissal, named in curated prose rather than the raw park detail.
      return 'Usage limit dismissed';
    default:
      // A future trigger kind degrades to the recorded prose, never a blank.
      return collapseDiagnostic(round.triggerDetail, TRIGGER_DETAIL_MAX);
  }
}

/**
 * The fix row for one inside stage: the NEWEST round the stage recorded, plus the identity/duration of the fix execution when the round has
 * one attached. Null when the stage recorded NO round — a fix row without
 * recovery evidence would be a promise, not a fact.
 */
export interface RecoveryProcessView {
  /** The process whose evidence opened the LATEST round — where Fix goes. */
  triggerProcessId: string;
  process: InsideProcessView;
}

export function recoveryProcess(
  rounds: readonly RoundWithDelivery[],
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

  // The COLLAPSED fix row is never silent (handoff §11 + §3.8): every state
  // names what is happening, the exhausted one states what to do.
  const stateDetail =
    // `revalidating` reads `pass` too, but it has its own copy — the stale-pass
    // wording below is for a round the STAGE overrode, not one that completed.
    latest.status === 'revalidating'
      ? `Fix completed; ${STAGE_TITLES[latest.sourceStage]} revalidation is running`
      : status === 'pass' && latest.status !== 'passed'
        ? `${STAGE_TITLES[latest.sourceStage]} passed on a later attempt — this round's own failure is history`
          : latest.status === 'exhausted'
            ? `Recovery exhausted after ${latest.maxRounds} ${latest.maxRounds === 1 ? 'round' : 'rounds'}. Resolve the remaining failure manually.`
            : latest.status === 'failed'
              ? 'the fix did not hold — the next round names the new cause'
              : latest.status === 'pending' || latest.status === 'fixing'
                ? `Fix started after ${triggerProse(latest)}`
                : latest.status === 'interrupted'
                  ? 'the fix session ended before it was done — it can be resumed'
                  : undefined;
  // @arch:V77: the stored fix brief's receipt state rides the row.
  const note = fixDeliveryNote(latest.fixDelivery);
  const detail = [stateDetail, note].filter((part) => part !== undefined && part !== '').join(' · ');

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
