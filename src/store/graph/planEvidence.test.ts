/**
 * Plan-evidence store: the graph run's durable plan rows, read for the
 * artifacts shelf's Plan artifact. `null` graph run → empty evidence (a
 * ticket the graph approach never drove has nothing to show).
 */

import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../db.js';
import { listGraphPlanEvidence } from './planEvidence.js';

function harness(over: { ticketId?: number; status?: string } = {}): {
  store: Store;
  ticketId: number;
  graphRunId: number;
} {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('PL-EV')").run().lastInsertRowid,
  );
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, '2026-08-11T00:00:00.000Z')`,
      )
      .run(over.ticketId ?? ticketId, over.status ?? 'running')
      .lastInsertRowid,
  );
  return { store, ticketId, graphRunId };
}

describe('listGraphPlanEvidence', () => {
  it('is empty for a ticket with no graph run', () => {
    const { store, ticketId } = harness();
    store.db.prepare('DELETE FROM approach_graph_runs WHERE ticket_id = ?').run(ticketId);
    expect(listGraphPlanEvidence(store.db, ticketId)).toEqual({
      graphRun: null,
      revisions: [],
      nodeRuns: [],
      plannerRuns: [],
      plannerArtifacts: [],
    });
  });

  it('reads the LATEST graph run only — an older run is superseded evidence', () => {
    const { store, ticketId } = harness({ status: 'closed' });
    // A second (newer) graph run for the same ticket on a LATER attempt.
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 1, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId);
    const latest = (
      store.db
        .prepare('SELECT MAX(id) AS id FROM approach_graph_runs WHERE ticket_id = ?')
        .get(ticketId) as { id: number }
    ).id;
    expect(listGraphPlanEvidence(store.db, ticketId).graphRun?.id).toBe(latest);
  });

  it('collects revisions (ordered), node runs, planner runs and planner artifacts', () => {
    const { store, ticketId, graphRunId } = harness();
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{"a":1}', 'fp1', 'active', '2026-08-11T00:00:00.000Z')`,
      )
      .run(graphRunId);
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, provider)
         VALUES (?, 1, 'bootstrap', 'submitted', 'codex')`,
      )
      .run(graphRunId);
    const revisionId = (
      store.db
        .prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number }
    ).id;
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, started_at)
         VALUES (?, ?, 'worker', 'agent', 1, 'completed', '2026-08-11T00:00:00.000Z')`,
      )
      .run(graphRunId, revisionId);
    const plannerRunId = (
      store.db
        .prepare('SELECT id FROM approach_planner_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number }
    ).id;
    store.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, NULL, 'task', ?, '/data/karst/graph/plan.md', 'sha', 'text/markdown', 512, '2026-08-11T00:00:00.000Z')`,
      )
      .run(graphRunId, plannerRunId);

    const evidence = listGraphPlanEvidence(store.db, ticketId);
    expect(evidence.graphRun).toMatchObject({ id: graphRunId, status: 'running' });
    expect(evidence.revisions).toEqual([
      { revision_number: 1, canonical_graph: '{"a":1}', status: 'active', created_at: '2026-08-11T00:00:00.000Z' },
    ]);
    expect(evidence.nodeRuns).toEqual([
      { id: expect.any(Number), node_id: 'worker', node_kind: 'agent', revision_id: revisionId, visit_number: 1, status: 'completed', ended_at: null },
    ]);
    expect(evidence.plannerRuns).toEqual([{ kind: 'bootstrap', status: 'submitted', provider: 'codex' }]);
    expect(evidence.plannerArtifacts).toEqual([
      { snapshot_path: '/data/karst/graph/plan.md', media_type: 'text/markdown', byte_size: 512 },
    ]);
  });

  it('includes only PLANNER-produced artifacts, never node outputs', () => {
    const { store, ticketId, graphRunId } = harness();
    store.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, artifact_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, 'node-output', '/data/karst/graph/out.md', 'sha', 'text/markdown', 512, '2026-08-11T00:00:00.000Z')`,
      )
      .run(graphRunId);
    expect(listGraphPlanEvidence(store.db, ticketId).plannerArtifacts).toEqual([]);
  });
});
