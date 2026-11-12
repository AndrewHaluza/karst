import type { Store } from '../../store/db.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { regenerateRepoOf, runRegenerate, type RegenerateSpec } from '../../workflow/gates/regenerate.js';
import { nowIso } from '../../model/time.js';
import type { MarkerStage } from '../../agent/markerStage.js';
import { runRequestedHostReruns } from '../../workflow/fixHostRerunRequest.js';
import { NO_NEW_COMMIT_REASON } from '../../workflow/fixRoundGuard.js';
import {
  describeHostRerun,
  hostRerunFailedGates,
  preBriefHostRerun,
  type FailedGate,
  type GateRerunResult,
  type HostRerunOutcome,
  type HostRerunReply,
} from '../../workflow/fixHostRerun.js';

export interface GateRerunDeps {
  readonly store: Store;
  /** The ticket's gate process: its sandbox runner, or the host's `runProcess`. */
  readonly runnerFor: (ticketId: number) => GateProcessRunner;
  /** The host's own runner, for `ship.regenerate` entries marked `sandbox: host`. */
  readonly hostRunner?: GateProcessRunner;
  /** The manifest `ship.regenerate` spec of a repo key; undefined when it declares none. */
  readonly regenerateFor?: (repo: string) => RegenerateSpec | undefined;
}

/** Re-run one failed gate in its repo's worktree; only a completed process has an exit code. */
export function makeGateRerun(deps: GateRerunDeps): (ticketId: number, gate: FailedGate) => Promise<GateRerunResult> {
  return async (ticketId, gate) => {
    const repo = gate.repo ?? (gate.kind === 'regenerate' ? regenerateRepoOf(gate.gateName) : null);
    const worktree = listWorktreesByTicket(deps.store, ticketId).find((w) => w.repo === repo);
    if (!worktree) throw new Error(`no worktree for repo ${repo ?? '(none)'}`);
    // The row's repo locates the worktree; the manifest key is only in the gate name.
    if (gate.kind === 'regenerate') return rerunRegenerate(deps, ticketId, gate, regenerateRepoOf(gate.gateName) ?? repo ?? '', worktree.path);
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

/** A composite gate runs through its own runner: the repo's `ship.regenerate` commands, in order. */
async function rerunRegenerate(deps: GateRerunDeps, ticketId: number, gate: FailedGate, repo: string, cwd: string): Promise<GateRerunResult> {
  const spec = deps.regenerateFor?.(repo);
  if (!spec || spec.commands.length === 0) {
    return { exitCode: null, cannotRerun: true, summary: `${gate.gateName} has no ship.regenerate commands in the manifest` };
  }
  const outcome = await runRegenerate(spec, cwd, { sandbox: deps.runnerFor(ticketId), host: deps.hostRunner }, false, nowIso);
  switch (outcome.kind) {
    case 'ok':
      return { exitCode: 0, summary: null };
    case 'failed':
      return { exitCode: outcome.result.exitCode, summary: summarizeGateFailure(outcome.result.output) };
    case 'stopped':
      return { exitCode: null, summary: 'aborted' };
  }
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

/** Production composition for the pre-brief re-run of an environment-signature gate failure. */
export function preBriefRerunFor(deps: GateRerunDeps): (ticketId: number) => Promise<HostRerunOutcome> {
  const runGate = makeGateRerun(deps);
  return (ticketId) => preBriefHostRerun(deps.store, ticketId, { runGate });
}

export interface RequestedRerunSweepDeps extends GateRerunDeps {
  readonly projectId: () => number | undefined;
  readonly debug?: (message: string) => void;
}

/**
 * The extension sweep for host CLI fix markers (@arch:AC-45): a refused `stage fix pass` stored a
 * re-run request; run it here, never in the CLI. A tick that finds a run in flight does nothing.
 */
export function makeRequestedRerunSweep(deps: RequestedRerunSweepDeps): () => Promise<void> {
  const runGate = makeGateRerun(deps);
  let running = false;
  return async () => {
    const projectId = deps.projectId();
    if (running || projectId === undefined) return;
    running = true;
    try {
      const outcomes = await runRequestedHostReruns(deps.store, projectId, { runGate });
      for (const o of outcomes) deps.debug?.(`[fix-rerun] requested by the host CLI: ${o.kind}`);
    } catch (err) {
      deps.debug?.(`[fix-rerun] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
}
