/**
 * A claimed node run records its start once: a retry keeps the first start,
 * and the Inside read falls back to the process run for an old row.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { createGraphRun } from './graphRuns.js';
import { insertReservedNodeRun, markNodeRunStarted, nodeRunsForGraphRunDisplay } from './nodeRuns.js';

function harness() {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = createGraphRun(store.db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
  const revisionId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-11T00:00:00.000Z')`,
      )
      .run(graphRunId).lastInsertRowid,
  );
  const nodeRunId = insertReservedNodeRun(store.db, {
    graphRunId,
    revisionId,
    nodeId: 'impl',
    nodeKind: 'agent',
    visitNumber: 1,
  });
  return { db: store.db, ticketId, graphRunId, nodeRunId };
}

describe('markNodeRunStarted', () => {
  it('stamps the start once and keeps the first start on a retry', () => {
    const { db, nodeRunId } = harness();
    expect(markNodeRunStarted(db, nodeRunId, '2026-08-11T01:00:00.000Z')).toBe(true);
    expect(markNodeRunStarted(db, nodeRunId, '2026-08-11T02:00:00.000Z')).toBe(false);
    const row = db.prepare('SELECT started_at FROM approach_node_runs WHERE id = ?').get(nodeRunId) as {
      started_at: string;
    };
    expect(row.started_at).toBe('2026-08-11T01:00:00.000Z');
  });
});

describe('nodeRunsForGraphRunDisplay', () => {
  it('falls back to the process run start when the node run has none', () => {
    const { db, ticketId, graphRunId, nodeRunId } = harness();
    const processRunId = Number(
      db
        .prepare(
          `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
           VALUES (?, 'impl', 'impl', 0, 'running', '2026-08-11T03:00:00.000Z')`,
        )
        .run(ticketId).lastInsertRowid,
    );
    db.prepare('UPDATE approach_node_runs SET process_run_id = ? WHERE id = ?').run(processRunId, nodeRunId);
    expect(nodeRunsForGraphRunDisplay(db, graphRunId)[0]!.started_at).toBe('2026-08-11T03:00:00.000Z');
  });

  it('prefers the recorded node run start over the process run start', () => {
    const { db, graphRunId, nodeRunId } = harness();
    markNodeRunStarted(db, nodeRunId, '2026-08-11T01:00:00.000Z');
    expect(nodeRunsForGraphRunDisplay(db, graphRunId)[0]!.started_at).toBe('2026-08-11T01:00:00.000Z');
  });

  it('stays null with no start and no process run', () => {
    const { db, graphRunId } = harness();
    expect(nodeRunsForGraphRunDisplay(db, graphRunId)[0]!.started_at).toBeNull();
  });
});
