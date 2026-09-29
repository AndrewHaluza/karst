/**
 * `recovery_rounds` (v30) — one row per CAUSAL recovery round: a gate failure
 * that entered the fix loop, snapshotted atomically with the verdict that
 * caused it (the round opens inside `commitGateOutcome`'s transition
 * premutate, so the failing verdict, its evidence and the round commit
 * together or not at all).
 *
 * The round is the durable owner of the recovery, and the driver reads the
 * committed `max_rounds` back from it — never from the live manifest, which
 * may have changed since the failure — and the round id back into the Fix
 * execution (`beginLiveFixExecution` / `confirmFixLaunch`), so every piece of
 * the recovery is linked by row, not reconstructed from mutable state.
 *
 * Status lifecycle:
 *   pending      — opened by the failing verdict, no Fix execution yet
 *   fixing       — a Fix process run is attached (live nudge or confirmed start)
 *   revalidating — the `stage fix pass` marker passed the Fix execution
 *   passed       — the revalidation outcome proved the fix (see below)
 *   failed       — the revalidation outcome disproved it, and the atomically
 *                  opened round of the NEW failure describes the new cause
 *   interrupted  — the Fix session died without the marker; never a pass, and
 *                  no additional round is consumed
 *
 * Revalidation: the next UAT run attaches to `uat_revalidation_stage_run_id`
 * (and, for a Review-origin round, the later Review run to
 * `review_revalidation_stage_run_id`). A UAT-origin round is completed or
 * failed by that UAT outcome; a Review-origin round needs BOTH — UAT must
 * pass (leaving the round revalidating) before Review's run is attached, and
 * only that Review outcome completes or fails the original round. An
 * intermediate UAT failure fails the Review-origin round and lets the
 * atomically created UAT round describe the new cause. The graph is never
 * bypassed: fix always re-enters uat.
 *
 * `store.db.prepare(...)` with positional `?` only, per the driver-agnostic
 * rule (the marker CLI's flat `node:sqlite` shim must be able to run the
 * completion paths without nesting transactions).
 */

export {
  type RecoverySourceStage,
  type RecoverySourceProcessId,
  type RecoveryTriggerKind,
  type RecoveryStatus,
  type RecoveryRound,
  type RecoveryDecision,
  currentEpisode,
  activeRecoverySeries,
  latestInterruptedRound,
  activeRoundAnyStage,
  activeFixRound,
  hasFixingRound,
  recoveryDecision,
  listRecoveryRounds,
  roundById,
} from './recoveryRoundsRead.js';

export {
  FIX_PARKED_INTERRUPTED,
  FIX_PARKED_EXHAUSTED,
  FIX_PARKED_NO_RESUMABLE_ROUND,
  FIX_PARKED_NO_FAILED_GATE,
  FIX_PARKED_PROCESS_UNAVAILABLE,
  FIX_PARKED_NO_EXECUTION,
  FIX_PARKED_STALLED,
  FIX_PARKED_LAUNCH_NEVER_STARTED,
  parkFixStage,
  type OpenRecoveryRoundInput,
  openRecoveryRound,
  completeRevalidation,
  attachRevalidationStageRun,
  type BeginLiveFixExecutionInput,
  beginLiveFixExecution,
  type RecordFixLaunchIntentInput,
  recordFixLaunchIntent,
  type ConfirmFixLaunchResult,
  confirmFixLaunch,
  completeFixExecution,
  interruptFixExecution,
  interruptActiveFixExecution,
  exhaustRecoveryRound,
  reopenInterruptedRound,
} from './recoveryRoundsWrite.js';

export {
  type StrandedFixKind,
  type StrandedFixRound,
  reconcileStrandedFixRounds,
  type SweepStalledFixOpts,
  sweepStalledFixRounds,
  sweepAbandonedFixLaunches,
  describeStrandedFixRound,
} from './recoveryRoundsSweeps.js';
