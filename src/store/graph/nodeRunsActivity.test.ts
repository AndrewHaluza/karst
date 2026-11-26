/**
 * T1385 — the first-activity read: the running node runs of a graph run with
 * the ticket's placement and whether any usage sample exists for the node's
 * process run. Absence of a sample is the watchdog's only trigger.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { createGraphRun } from './graphRuns.js';
import { runningNodeRunsForFirstActivity } from './nodeRuns.js';

const NOW = '2026-11-26T10:00:00.000Z';

function harness(placement: string | null = null) {
  const store = openStore(':memory:');
  const db = store.db;
  const projectId = Number(
    db.prepare("INSERT INTO projects (slug, name) VALUES ('p', 'P')").run().lastInsertRowid,
  );
  const ticketId = Number(
    db
      .prepare("INSERT INTO tickets (key, project_id, stage_current) VALUES ('T-1', ?, 'impl')")
      .run(projectId).lastInsertRowid,
  );
  if (placement !== null) {
    db.prepare('UPDATE tickets SET placement_backend = ? WHERE id = ?').run(placement, ticketId);
  }
  const graphRunId = createGraphRun(db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: NOW,
  });
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, NOW).lastInsertRowid,
  );

  const processRun = (startedAt: string = NOW): number =>
    Number(
      db
        .prepare(
          `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
           VALUES (?, 'impl', 'graph-node', 0, 'running', ?)`,
        )
        .run(ticketId, startedAt).lastInsertRowid,
    );

  const nodeRun = (input: {
    nodeId: string;
    status?: string;
    provider?: string | null;
    processRunId?: number | null;
    startedAt?: string | null;
  }): number =>
    Number(
      db
        .prepare(
          `INSERT INTO approach_node_runs
             (graph_run_id, revision_id, node_id, node_kind, visit_number, status, provider,
              process_run_id, started_at)
           VALUES (?, ?, ?, 'agent', 1, ?, ?, ?, ?)`,
        )
        .run(
          graphRunId,
          revisionId,
          input.nodeId,
          input.status ?? 'running',
          input.provider === undefined ? 'opencode2' : input.provider,
          input.processRunId === undefined ? null : input.processRunId,
          input.startedAt === undefined ? NOW : input.startedAt,
        ).lastInsertRowid,
    );

  return { store, db, ticketId, graphRunId, processRun, nodeRun };
}

describe('runningNodeRunsForFirstActivity', () => {
  it('returns a running node with no sample, its process run and the host placement', () => {
    const { db, graphRunId, processRun, nodeRun } = harness();
    const processRunId = processRun();
    const id = nodeRun({ nodeId: 'impl', processRunId });
    expect(runningNodeRunsForFirstActivity(db, graphRunId)).toEqual([
      {
        id,
        process_run_id: processRunId,
        provider: 'opencode2',
        launched_at: NOW,
        placement: null,
        hasUsageSample: false,
      },
    ]);
  });

  it('reports the recorded placement and a sample for the process run', () => {
    const { db, graphRunId, processRun, nodeRun } = harness('sandbox');
    const processRunId = processRun();
    nodeRun({ nodeId: 'impl', processRunId });
    db.prepare(
      `INSERT INTO interactive_usage_samples
         (process_run_id, source_event_id, provider, provider_session_id,
          input_tokens, output_tokens, observed_at)
       VALUES (?, 'evt-1', 'opencode2', 'sess-1', 10, 5, ?)`,
    ).run(processRunId, NOW);
    expect(runningNodeRunsForFirstActivity(db, graphRunId)).toMatchObject([
      { placement: 'sandbox', hasUsageSample: true },
    ]);
  });

  it('returns only running nodes, in id order', () => {
    const { db, graphRunId, processRun, nodeRun } = harness();
    const first = nodeRun({ nodeId: 'a', processRunId: processRun() });
    nodeRun({ nodeId: 'b', status: 'blocked', processRunId: processRun() });
    const third = nodeRun({ nodeId: 'c', processRunId: processRun() });
    expect(runningNodeRunsForFirstActivity(db, graphRunId).map((r) => r.id)).toEqual([first, third]);
  });

  it('has no sample when the node run has no process run', () => {
    const { db, graphRunId, nodeRun } = harness();
    const id = nodeRun({ nodeId: 'impl', processRunId: null });
    expect(runningNodeRunsForFirstActivity(db, graphRunId)).toMatchObject([
      { id, process_run_id: null, hasUsageSample: false },
    ]);
  });

  it('reads the start of the CURRENT launch from the process run, not the first claim', () => {
    // A relaunch keeps the node's `started_at` (the first claim) and opens a
    // new process run: the watchdog window must start at the new launch.
    const { db, graphRunId, processRun, nodeRun } = harness();
    const relaunchedAt = '2026-11-26T10:30:00.000Z';
    nodeRun({ nodeId: 'impl', processRunId: processRun(relaunchedAt), startedAt: NOW });
    expect(runningNodeRunsForFirstActivity(db, graphRunId)).toMatchObject([
      { launched_at: relaunchedAt },
    ]);
  });

  it('falls back to the node start when the process run has no start', () => {
    const { db, graphRunId, nodeRun } = harness();
    nodeRun({ nodeId: 'impl', processRunId: null, startedAt: NOW });
    expect(runningNodeRunsForFirstActivity(db, graphRunId)).toMatchObject([{ launched_at: NOW }]);
  });
});
