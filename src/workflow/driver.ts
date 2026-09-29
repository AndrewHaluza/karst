import type { Store } from '../store/db.js';
import type { StageKey, StageRunResult } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import type { IntegrateOutcome } from './subtaskIntegration.js';

/**
 * The fixed vocabulary of human-boundary reasons the driver itself names
 * (as opposed to the free-text `${blocker}: ${reason}` a gate stage's own
 * block produces below) — a closed union, not a bare `string`, so a typo in
 * one of these literals is a compile error rather than a silent mismatch
 * with the dashboard's copy that reads them.
 */
export type DriverBoundaryReason =
  | 'ship-confirm'
  | 'awaiting-merge'
  | 'gate-failed'
  | 'awaiting-marker'
  | 'subtask-integration-parked'
  | 'subtask-integration-deferred'
  | 'not-spun';

/**
 * The stage driver (§11/§12): after the explicit impl/fix marker leaves a ticket
 * at a deterministic gate, walk it FORWARD by running each gate's runner and
 * re-reading `stage_current` — until a human boundary (fix/ship/done), a Stop, or
 * an error. It NEVER authors a transition itself; the runners own that. This is a
 * pure sequencer over the runner results.
 */

export type DriverStatus = 'running' | 'stopped' | 'blocked' | 'paused';

export interface StageOutcome {
  stage: StageKey;
  status: DriverStatus;
  reason?: string;
}

export interface StageDriverDeps {
  store: Store;
  runUat: (ticketId: number, cwd: string) => Promise<StageRunResult>;
  runReview: (ticketId: number, cwd: string) => Promise<StageRunResult>;
  worktreeFor: (ticketId: number) => string | null;
  onProgress: (ticketId: number, stage: StageKey, status: DriverStatus) => void;
  shouldContinue: () => boolean;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[driver]`.
   * Absent → no debug lines. The host binds it to `Logger.debug`, which is a
   * no-op unless the manifest's `debug` flag is on.
   */
  debug?: (message: string) => void;
  /**
   * The sub-task integration seam (NDL-75, design §6). Runs at the TOP of the
   * driver, before any boundary check, so a parent that was `running` when a
   * sub-task landed integrates the child's work on its next drive — the
   * deferred half of "invoked from onSubtaskLanded (if parent idle) or the
   * parent's next driver seam (leave-impl / ship entry)". A park STOPS the
   * driver, and so does a deferral: running a gate (uat/review) with the child's
   * work unmerged is the failure this seam exists to prevent, and neither
   * outcome merged anything. Absent → no integration happens here.
   */
  integrateSubtasks?: (ticketId: number) => Promise<IntegrateOutcome>;
}

function finish(
  deps: StageDriverDeps,
  ticketId: number,
  stage: StageKey,
  status: DriverStatus,
  reason?: string,
): StageOutcome {
  deps.onProgress(ticketId, stage, status);
  return reason ? { stage, status, reason } : { stage, status };
}

/**
 * The parent's resting stage for a seam-blocked outcome. `stage_current` is
 * `string | null` at the store layer and the seam only ever runs for a ticket
 * sitting at a gate, so a null here is an invariant violation — surfaced loudly
 * rather than cast away into a null `StageOutcome.stage`.
 */
function seamStage(deps: StageDriverDeps, ticketId: number, why: string): StageKey {
  const stage = getTicket(deps.store, ticketId).stageCurrent as StageKey | null;
  if (stage === null) {
    throw new Error(`ticket ${ticketId}: ${why} but the parent has no current stage`);
  }
  return stage;
}

export async function runStageDriver(deps: StageDriverDeps, ticketId: number): Promise<StageOutcome> {
  // Sub-task integration seam (NDL-75): absorb any landed sub-task's work
  // before the boundary checks and gate runners below. This is the parent's
  // "leave-impl"/next-drive boundary — the place a deferred integration (parent
  // was running at landing) finally runs once the parent is idle.
  if (deps.integrateSubtasks) {
    deps.debug?.(`[driver] ticket ${ticketId}: integrating landed sub-tasks before driving`);
    const outcome = await deps.integrateSubtasks(ticketId);
    if (outcome.parked) {
      // The child's work is unmerged; do NOT run the stage's gates on a stale
      // tree. The park names why and holds until a seam integrates or a human
      // resolves it.
      const stage = seamStage(deps, ticketId, 'sub-task integration parked');
      deps.debug?.(
        `[driver] ticket ${ticketId}: sub-task integration parked at '${stage}' — not driving`,
      );
      return finish(deps, ticketId, stage, 'blocked', 'subtask-integration-parked');
    }
    if (outcome.deferred) {
      // The parent's agent was running, so integration deferred and NOTHING
      // merged. Running a gate here would gate an unintegrated tree — the exact
      // failure the seam exists to prevent. A parent is never `running` when the
      // driver runs its gates, so this is an assertion that blocks loudly if
      // that invariant ever breaks rather than silently running uat/review on
      // stale work.
      const stage = seamStage(deps, ticketId, 'sub-task integration deferred');
      deps.debug?.(
        `[driver] ticket ${ticketId}: sub-task integration deferred (parent running) — not driving`,
      );
      return finish(deps, ticketId, stage, 'blocked', 'subtask-integration-deferred');
    }
  }

  for (;;) {
    // stage_current is `string | null` at the store layer; STAGE_KEYS values in
    // practice (house precedent: src/store/stages.ts rowToStage).
    const stage = getTicket(deps.store, ticketId).stageCurrent as StageKey;
    deps.debug?.(`[driver] ticket ${ticketId}: loop entry, stage_current = ${stage}`);

    // Human boundaries — stop without running.
    // `ship` covers TWO different waits that both read `stage === 'ship'`:
    // parked pending its first confirm click, or already shipped and now
    // parked on the merge gate (`workflow/mergeGate.ts`) waiting for a PR to
    // land — a human's click on GitHub, or a teammate's. The driver has
    // nothing to run in either case and must not spin waiting for one, but
    // the two are different news and are reported differently: only the
    // `awaiting-merge` block recorded on the ship row (set by
    // `resolveShipLanding`/`settleShipGate`) tells them apart.
    if (stage === 'ship') {
      const reason: DriverBoundaryReason =
        stageBlock(deps.store, ticketId, 'ship')?.kind === 'awaiting-merge'
          ? 'awaiting-merge'
          : 'ship-confirm';
      deps.debug?.(`[driver] ticket ${ticketId}: human boundary 'ship' (${reason})`);
      return finish(deps, ticketId, stage, 'blocked', reason);
    }
    if (stage === 'fix') {
      deps.debug?.(`[driver] ticket ${ticketId}: human boundary 'fix' (gate-failed)`);
      return finish(deps, ticketId, stage, 'blocked', 'gate-failed');
    }
    if (stage === 'impl') {
      deps.debug?.(`[driver] ticket ${ticketId}: human boundary 'impl' (awaiting-marker)`);
      return finish(deps, ticketId, stage, 'blocked', 'awaiting-marker');
    }
    if (stage === 'scope') {
      deps.debug?.(`[driver] ticket ${ticketId}: human boundary 'scope' (not-spun)`);
      return finish(deps, ticketId, stage, 'blocked', 'not-spun');
    }
    if (stage === 'done') {
      deps.debug?.(`[driver] ticket ${ticketId}: terminal stage 'done'`);
      return finish(deps, ticketId, stage, 'stopped');
    }

    // Stop requested — halt at this gate boundary before running it.
    if (!deps.shouldContinue()) {
      deps.debug?.(`[driver] ticket ${ticketId}: stop requested at '${stage}'`);
      return finish(deps, ticketId, stage, 'stopped');
    }

    const cwd = deps.worktreeFor(ticketId);
    if (!cwd) throw new Error(`ticket ${ticketId} has no worktree for stage '${stage}'`);
    deps.debug?.(`[driver] ticket ${ticketId}: dispatching '${stage}' runner (cwd ${cwd})`);

    deps.onProgress(ticketId, stage, 'running');
    const result = stage === 'uat'
      ? await deps.runUat(ticketId, cwd)
      : await deps.runReview(ticketId, cwd);

    // Exhaustive by construction. Two `if`s and a fallthrough read ANY unknown
    // kind as `advanced`, so a fourth `StageRunResult` variant would silently
    // re-spin the loop over the same gate — and an unbroken await chain starves
    // the timers a test timeout needs, so it hangs rather than reports.
    switch (result.kind) {
      // A block is a resting place, not an error: the stage stays current, the
      // row carries why, and the sweep skips it until a human clears it.
      case 'blocked':
        deps.debug?.(
          `[driver] ticket ${ticketId}: '${stage}' runner blocked (${result.blocker}: ${result.reason})`,
        );
        return finish(deps, ticketId, stage, 'blocked', `${result.blocker}: ${result.reason}`);
      case 'stopped':
        deps.debug?.(`[driver] ticket ${ticketId}: '${stage}' runner stopped`);
        return finish(deps, ticketId, stage, 'stopped');
      case 'advanced':
        // The runner already transitioned; re-read stage_current and continue.
        deps.debug?.(`[driver] ticket ${ticketId}: '${stage}' runner advanced — continuing`);
        break;
      default: {
        const unreachable: never = result;
        throw new Error(
          `stage '${stage}' runner returned an unrecognized result: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  }
}
