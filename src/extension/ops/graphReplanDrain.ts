/**
 * The host's replan-drain drive (T1322).
 *
 * A replan election moves the run `running → draining` and drains its revision,
 * while a node can still be live. The completion pipeline integrates such a
 * node in a replan drain (no successor token), so the host must drive it: a
 * `completing` node otherwise holds the drain for ever, and the node's only
 * exit is the end of its process, which cancels its commits (T1317).
 *
 * With no planner allocated for this drain, the drain has not quiesced yet.
 * Drive the completing nodes first; the pipeline releases their leases and
 * process slots. Then, when the drain still stands, allocate the N+1 planner at
 * once instead of waiting for the next reconcile. A drain that already has a
 * planner has nothing live, so it is left alone (reconcile owns the relaunch of
 * a stale or cancelled planner). A Stop drain keeps its revision `active` and
 * is never a replan drain: it waits for a deliberate Restart.
 *
 * vscode-free: the db and both host seams are injected, so `extension.ts` only
 * wires it.
 */

import { inReplanDrain, drainingRevisionNumber } from '../../approaches/graph/coordinator/replanDrain.js';
import { latestReplanPlannerForTarget } from '../../store/graph/plannerRuns.js';
import { graphRunStatus } from '../../store/graph/graphRuns.js';
import type { GraphDb } from '../../store/graph/transitions.js';

export interface ReplanDrainDeps {
  db: GraphDb;
  /** Drive every `completing` node of the run through the completion pipeline,
   *  then settle (the host's `driveCompletingNodes`). */
  driveCompletingNodes: (graphRunId: number) => Promise<void>;
  /** Allocate and launch the drain's replan planner (the host's
   *  `relaunchReplanPlannerHost`). It re-checks `draining` + quiescence. */
  relaunchReplanPlanner: (graphRunId: number) => Promise<void>;
}

/**
 * Drive a replan drain's live nodes, then allocate its planner when the drain
 * still stands. A no-op for any other run status and for a Stop drain.
 */
export async function driveReplanDrain(
  deps: ReplanDrainDeps,
  graphRunId: number,
): Promise<void> {
  const { db } = deps;
  if (graphRunStatus(db, graphRunId) !== 'draining') return;
  // A Stop drain keeps its revision `active`: it waits for a deliberate Restart
  // and must start nothing.
  if (!inReplanDrain(db, graphRunId)) return;
  const draining = drainingRevisionNumber(db, graphRunId);
  if (draining === undefined) return;
  // A planner row of ANY status (also `stale` or `cancelled`) means this drain
  // was already planned: reconcile owns its relaunch, and no live node can
  // remain once a planner was allocated.
  if (latestReplanPlannerForTarget(db, graphRunId, draining + 1) !== undefined) return;

  await deps.driveCompletingNodes(graphRunId);

  // The pipeline or a concurrent window may have moved the run. Allocate the
  // planner only while THIS drain still stands; `beginReplanPlannerRun` is
  // single-flight, so a raced relaunch is harmless.
  if (graphRunStatus(db, graphRunId) !== 'draining') return;
  if (!inReplanDrain(db, graphRunId)) return;
  await deps.relaunchReplanPlanner(graphRunId);
}
