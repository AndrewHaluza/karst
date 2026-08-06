import type { Store } from '../store/db.js';
import type { StageKey, StageRunResult } from '../model/types.js';
import { getTicket } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';

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
  | 'not-spun';

/**
 * The stage driver (§11/§12): after the explicit impl/fix marker leaves a ticket
 * at a deterministic gate, walk it FORWARD by running each gate's runner and
 * re-reading `stage_current` — until a human boundary (fix/ship/done), a Stop, or
 * an error. It NEVER authors a transition itself; the runners own that. This is a
 * pure sequencer over the runner results.
 */

export type DriverStatus = 'running' | 'stopped' | 'blocked';

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

export async function runStageDriver(deps: StageDriverDeps, ticketId: number): Promise<StageOutcome> {
  for (;;) {
    // stage_current is `string | null` at the store layer; STAGE_KEYS values in
    // practice (house precedent: src/store/stages.ts rowToStage).
    const stage = getTicket(deps.store, ticketId).stageCurrent as StageKey;

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
      return finish(deps, ticketId, stage, 'blocked', reason);
    }
    if (stage === 'fix') return finish(deps, ticketId, stage, 'blocked', 'gate-failed');
    if (stage === 'impl') return finish(deps, ticketId, stage, 'blocked', 'awaiting-marker');
    if (stage === 'scope') return finish(deps, ticketId, stage, 'blocked', 'not-spun');
    if (stage === 'done') return finish(deps, ticketId, stage, 'stopped');

    // Stop requested — halt at this gate boundary before running it.
    if (!deps.shouldContinue()) return finish(deps, ticketId, stage, 'stopped');

    const cwd = deps.worktreeFor(ticketId);
    if (!cwd) throw new Error(`ticket ${ticketId} has no worktree for stage '${stage}'`);

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
        return finish(deps, ticketId, stage, 'blocked', `${result.blocker}: ${result.reason}`);
      case 'stopped':
        return finish(deps, ticketId, stage, 'stopped');
      case 'advanced':
        // The runner already transitioned; re-read stage_current and continue.
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
