/**
 * "Is any process of this graph run still alive?" — ONE definition.
 *
 * Two callers ask it and they must agree, because both act on the answer by
 * moving a run into a state the other cannot undo: the reconcile sweep's
 * successor rule (never mark a run `stale` while something is still running)
 * and Stop (never drain a run whose processes it could not reach — see
 * `stopActiveGraph`). "This window cannot see the terminal" is not evidence of
 * death, so the answer is read from DURABLE identity: the recorded pid of a
 * node run's `process_runs` row, probed through the injected facts source
 * (`runtime/serverIdentity.ts`, the mandated evidence source).
 *
 * Deliberately conservative — a pid the OS says is alive counts as live even
 * when it cannot be attributed, because neither caller may accuse a process
 * that might be another window's.
 *
 * Host-agnostic: db and process facts injected; no vscode, no transport.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { nodeRunProcessPids } from '../../../store/graph/nodeRuns.js';
import type { ProcessFactsSource } from '../../../runtime/serverIdentity.js';

/**
 * Whether any node run of the graph run carries a recorded pid the OS says is
 * alive. A node with no `process_run_id`, or a row whose pid is NULL, carries
 * no evidence either way and is never counted as alive.
 */
export async function graphRunHasLiveNodeProcess(
  db: GraphDb,
  facts: ProcessFactsSource,
  graphRunId: number,
  debug?: (message: string) => void,
): Promise<boolean> {
  const rows = nodeRunProcessPids(db, graphRunId);
  for (const row of rows) {
    if (row.pid === null) continue;
    if (await facts.isAlive(row.pid)) {
      debug?.(`[graph] liveness: run ${graphRunId} node run ${row.id} pid ${row.pid} is alive`);
      return true;
    }
  }
  debug?.(
    `[graph] liveness: run ${graphRunId} has no live node process (${rows.length} row(s) with a recorded pid)`,
  );
  return false;
}
