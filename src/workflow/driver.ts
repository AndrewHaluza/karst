import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';

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
  runUat: (ticketId: number, cwd: string) => Promise<StageKey>;
  runReview: (ticketId: number, cwd: string) => Promise<StageKey>;
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
    if (stage === 'ship') return finish(deps, ticketId, stage, 'blocked', 'ship-confirm');
    if (stage === 'fix') return finish(deps, ticketId, stage, 'blocked', 'gate-failed');
    if (stage === 'impl') return finish(deps, ticketId, stage, 'blocked', 'awaiting-marker');
    if (stage === 'scope') return finish(deps, ticketId, stage, 'blocked', 'not-spun');
    if (stage === 'done') return finish(deps, ticketId, stage, 'stopped');

    // Stop requested — halt at this gate boundary before running it.
    if (!deps.shouldContinue()) return finish(deps, ticketId, stage, 'stopped');

    const cwd = deps.worktreeFor(ticketId);
    if (!cwd) throw new Error(`ticket ${ticketId} has no worktree for stage '${stage}'`);

    deps.onProgress(ticketId, stage, 'running');
    if (stage === 'uat') await deps.runUat(ticketId, cwd);
    else await deps.runReview(ticketId, cwd);
    // Loop: the runner already transitioned; re-read stage_current and continue.
  }
}
