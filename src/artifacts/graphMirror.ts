/**
 * Graph mirror: feed a ticket's graph artifact instances into the unified
 * artifact history (`source=graph`). Graph keeps its own store for causal
 * binding; this only copies. Instances with a non-null `sensitivity` are
 * skipped — the artifact store may be shared later, graph sensitivity must hold.
 */

import type { Store } from '../store/db.js';
import type { ArtifactStore } from './store.js';

export const GRAPH_REPO = 'graph';
export const SOURCE_GRAPH = 'graph';

interface InstanceRow {
  id: number;
  graph_run_id: number;
  artifact_id: string;
  snapshot_path: string;
  approach_id: string;
  sensitivity: string | null;
}

export interface GraphMirrorResult {
  committed: number;
  skippedSensitive: number;
}

export async function mirrorGraphArtifacts(
  deps: { store: Store; artifacts: Pick<ArtifactStore, 'commitRevision'>; debug: (m: string) => void },
  ticketId: number,
): Promise<GraphMirrorResult> {
  deps.debug(`[artifacts] graph mirror for ticket ${ticketId}`);
  const rows = deps.store.db
    .prepare(
      `SELECT i.id, i.graph_run_id, i.artifact_id, i.snapshot_path, i.sensitivity, r.approach_id
         FROM approach_artifact_instances i
         JOIN approach_graph_runs r ON r.id = i.graph_run_id
        WHERE r.ticket_id = ?
        ORDER BY i.id`,
    )
    .all(ticketId) as InstanceRow[];
  let committed = 0;
  let skippedSensitive = 0;
  for (const row of rows) {
    if (row.sensitivity !== null) {
      skippedSensitive += 1;
      deps.debug(`[artifacts] graph mirror skips sensitive instance ${row.id}`);
      continue;
    }
    try {
      const sha = await deps.artifacts.commitRevision({
        ticketId,
        repo: GRAPH_REPO,
        relPath: `run-${row.graph_run_id}/${row.artifact_id}`,
        sourcePath: row.snapshot_path,
        trailers: { source: SOURCE_GRAPH, approach: row.approach_id, kind: 'graph' },
      });
      if (sha !== null) committed += 1;
    } catch (err) {
      deps.debug(`[artifacts] graph mirror failed for instance ${row.id}: ${String(err)}`);
    }
  }
  deps.debug(`[artifacts] graph mirror: ${committed} committed, ${skippedSensitive} sensitive skipped`);
  return { committed, skippedSensitive };
}
