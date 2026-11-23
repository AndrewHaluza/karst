/**
 * The replan-drain predicate (T1322).
 *
 * A replan election drains its revision (`active → draining`) and leaves the
 * run with no `active` revision. A Stop drain keeps its revision `active` and
 * waits for a deliberate Restart, so it is never a replan drain.
 *
 * Host-agnostic: the db is injected; this module imports only the store type,
 * so the reconcile sweep, the completion pipeline and the host can share it.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';

/**
 * True when the run's newest revision is `draining` and it has NO `active`
 * revision. The rule reads the revisions only, never the run status: reconcile
 * also asks it for a `running` run, the corruption that a Stop/Start over an
 * in-flight replan produced when `restartStoppedGraph` flipped the run back
 * without checking for an active revision. A caller that needs a run that
 * drains now checks the run status too.
 *
 * In this shape only a replan planner's accepted submission moves the run on:
 * the sweep needs an active revision and `quiescenceBlockedBy` answers
 * `no-revision`.
 */
export function inReplanDrain(db: GraphDb, graphRunId: number): boolean {
  const active = db
    .prepare(
      "SELECT 1 AS x FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active' LIMIT 1",
    )
    .get(graphRunId);
  if (active !== undefined) return false;
  const newest = db
    .prepare(
      'SELECT status FROM approach_graph_revisions WHERE graph_run_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(graphRunId) as { status: string } | undefined;
  return newest?.status === 'draining';
}
