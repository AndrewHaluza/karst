/**
 * The orphan sweep (T1139): a non-terminal graph run whose ticket no longer
 * owns it (archived, at `done`, past the run's stage, or on another approach)
 * is closed through the ONE Cancel operation with reason `orphan-sweep`.
 *
 * A refusal (a foreign or unknown live pid) is logged and the run is left for
 * the next pass; nothing is signalled and no row changes in that case.
 *
 * Host-agnostic: the cancel dependencies are injected.
 */

import { orphanGraphRunIdsForProject } from '../../../store/graph/graphRuns.js';
import { cancelGraphRun, type CancelGraphRunDeps } from '../cancel.js';
import { NON_TERMINAL_GRAPH_RUN_STATUSES } from './reconcileScope.js';

export const ORPHAN_SWEEP_REASON = 'orphan-sweep';

export interface OrphanSweepResult {
  cancelled: number[];
  refused: number[];
}

export async function sweepOrphanGraphRuns(
  deps: CancelGraphRunDeps,
  projectId: number,
): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { cancelled: [], refused: [] };
  const ids = orphanGraphRunIdsForProject(deps.db, projectId, NON_TERMINAL_GRAPH_RUN_STATUSES);
  for (const graphRunId of ids) {
    const outcome = await cancelGraphRun(deps, graphRunId, ORPHAN_SWEEP_REASON);
    switch (outcome.outcome) {
      case 'cancelled':
        result.cancelled.push(graphRunId);
        deps.debug?.(`[graph] orphan sweep: run ${graphRunId} cancelled`);
        break;
      case 'refused-live-process':
        result.refused.push(graphRunId);
        deps.debug?.(
          `[graph] orphan sweep: run ${graphRunId} left for the next pass — ` +
            outcome.refusals.map((r) => `${r.kind} ${r.runId} pid ${r.pid} ${r.reason}`).join(', '),
        );
        break;
      default:
        // already-terminal or raced: another path closed or moved the run.
        break;
    }
  }
  return result;
}
