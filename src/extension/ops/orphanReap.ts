import type { Store } from '../../store/db.js';
import type { UsageTracking } from '../../agent/adapter.js';
import {
  onProcessRunsSuperseded,
  recordProcessRunChild,
  type ProcessRun,
} from '../../store/processRuns.js';
import { killTree } from '../../runtime/processTree.js';
import { reapOrphanedChild, type OrphanReapDeps } from '../../runtime/orphanChild.js';
import { systemAsyncProcessFacts } from '../../runtime/serverIdentity.js';

export interface OrphanReapOpsDeps {
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
  /** Test seams; default to the real OS probes and `killTree`. */
  facts?: OrphanReapDeps['facts'];
  kill?: OrphanReapDeps['kill'];
}

/**
 * Reap the headless children of runs a dead host left behind (window reload or
 * crash). Sequential and fault-isolated: one run's probe failure is logged and
 * never stops the others, and the returned promise never rejects. Used for the
 * runs a new open superseded and for the runs the activation sweep found stale.
 */
export async function reapOrphanedChildren(
  runs: readonly ProcessRun[],
  deps: OrphanReapOpsDeps,
): Promise<void> {
  const reapDeps: OrphanReapDeps = {
    facts: deps.facts ?? systemAsyncProcessFacts,
    kill: deps.kill ?? killTree,
    debug: deps.debug,
  };
  for (const run of runs) {
    try {
      await reapOrphanedChild(run, reapDeps);
    } catch (err) {
      deps.logError(`karst: orphan reap of process run ${run.id} failed`, err);
    }
  }
}

/**
 * Bind the reap to `store`: a new open that supersedes a stale run reaps that
 * run's headless child when its owner host is dead. Returns the unbinder.
 */
export function bindOrphanReap(store: Store, deps: OrphanReapOpsDeps): () => void {
  return onProcessRunsSuperseded(store, (runs) => {
    void reapOrphanedChildren(runs, deps);
  });
}

/**
 * Record the headless child a call just spawned on its process run, so a later
 * host can find it if this window reloads first. A call with no process run
 * (a draft, an interactive helper) records nothing. Never throws.
 */
export function recordSpawnedChild(
  store: Store,
  tracking: UsageTracking | undefined,
  pid: number,
  logError: OrphanReapOpsDeps['logError'],
  now: () => string = () => new Date().toISOString(),
): void {
  const runId = tracking?.processRunId;
  if (runId == null) return;
  try {
    recordProcessRunChild(store, runId, pid, now());
  } catch (err) {
    logError('karst: could not record the headless child pid', err);
  }
}
