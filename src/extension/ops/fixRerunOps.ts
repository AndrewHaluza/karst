import type { Store } from '../../store/db.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { MarkerStage } from '../../agent/markerStage.js';
import { NO_NEW_COMMIT_REASON } from '../../workflow/fixRoundGuard.js';
import {
  describeHostRerun,
  hostRerunFailedGates,
  type FailedGate,
  type GateRerunResult,
  type HostRerunOutcome,
  type HostRerunReply,
} from '../../workflow/fixHostRerun.js';

export interface GateRerunDeps {
  readonly store: Store;
  /** The ticket's gate process: its sandbox runner, or the host's `runProcess`. */
  readonly runnerFor: (ticketId: number) => GateProcessRunner;
}

/** Re-run one failed gate in its repo's worktree; only a completed process has an exit code. */
export function makeGateRerun(deps: GateRerunDeps): (ticketId: number, gate: FailedGate) => Promise<GateRerunResult> {
  return async (ticketId, gate) => {
    const worktree = listWorktreesByTicket(deps.store, ticketId).find((w) => w.repo === gate.repo);
    if (!worktree) throw new Error(`no worktree for repo ${gate.repo ?? '(none)'}`);
    const outcome = await deps.runnerFor(ticketId)(gate.command, gate.args, worktree.path, {});
    switch (outcome.kind) {
      case 'completed':
        return { exitCode: outcome.exitCode, summary: outcome.exitCode === 0 ? null : summarizeGateFailure(outcome.output) };
      case 'spawnFailed':
        return { exitCode: null, summary: `could not start: ${outcome.message}` };
      case 'timedOut':
        return { exitCode: null, summary: 'timed out' };
      case 'aborted':
        return { exitCode: null, summary: 'aborted' };
    }
  };
}

export interface RecoverRefusalDeps {
  readonly rerun: (ticketId: number) => Promise<HostRerunOutcome>;
  readonly debug?: (message: string) => void;
}

/** The `markerFlow.recoverRefusal` binding: only a no-new-commit fix refusal triggers the host re-run. */
export function makeRecoverRefusal(
  ticketId: number,
  deps: RecoverRefusalDeps,
): (stage: MarkerStage, stderr: string) => Promise<HostRerunReply | undefined> {
  return async (stage, stderr) => {
    if (stage !== 'fix' || !stderr.includes(NO_NEW_COMMIT_REASON)) return undefined;
    const outcome = await deps.rerun(ticketId);
    deps.debug?.(`[fix-rerun] ticket ${ticketId}: ${outcome.kind}`);
    return describeHostRerun(outcome);
  };
}

/** Production composition: re-run through the store-backed workflow with the host's gate runner. */
export function hostRerunFor(deps: GateRerunDeps): (ticketId: number) => Promise<HostRerunOutcome> {
  const runGate = makeGateRerun(deps);
  return (ticketId) => hostRerunFailedGates(deps.store, ticketId, { runGate });
}
