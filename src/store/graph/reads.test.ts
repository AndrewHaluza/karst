/**
 * NDL-60 — the named read helpers over the three graph-run tables. These tests
 * pin the helpers directly; the runtime suites exercise them through callers.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import {
  graphRunApproachId,
  graphRunDiagnosticRef,
  graphRunExpertRunCount,
  graphRunExistsForTicket,
  graphRunIdStatusBlockedReason,
  graphMarkerReadyForTicket,
  graphRunNodeRunCount,
  graphRunStatus,
  graphRunStatusForTicket,
  graphRunTicketId,
  latestGraphRunForTicket,
  nextGraphRunIdForTicketAfter,
  runningGraphRunIdsForProject,
  ticketIdsAwaitingGraphDrive,
} from './graphRuns.js';
import {
  countNodeRunsForRevisionNode,
  countNodeRunsForRevisionNodeByOutcome,
  countNodeRunsInStatusesForGraphRun,
  createNodeRun,
  latestNodeRunIdForRevisionNode,
  nextVisitNumber,
  nodeRunBaseHeads,
  nodeRunStatus,
  nodeRunsForGraphRun,
  runnableNodeRunsForGraphRun,
  writeNodeRunBaseHeads,
} from './nodeRuns.js';
import {
  createPlannerRun,
  hasLiveReplanPlanner,
  latestPlannerRunForGraphRunKind,
  nextPlannerRunNumber,
  plannerRunCompileAttempt,
  plannerRunGraphRunId,
  plannerRunIdsForGraphRun,
  plannerRunStatus,
  submittedPlannerRunForGraphRun,
} from './plannerRuns.js';
import { createRevision } from './revisions.js';

const NOW = '2026-09-29T00:00:00.000Z';

interface Harness {
  store: ReturnType<typeof openStore>;
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
}

function harness(status = 'running'): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  const projectId = Number(
    db.prepare("INSERT INTO projects (slug, name) VALUES ('p1', 'P1')").run().lastInsertRowid,
  );
  const ticketId = Number(
    db
      .prepare("INSERT INTO tickets (key, project_id, stage_current) VALUES ('T-1', ?, 'impl')")
      .run(projectId).lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 1, 'karst-graph-engineering', ?, ?)`,
      )
      .run(ticketId, status, NOW).lastInsertRowid,
  );
  const revisionId = createRevision(db, {
    graphRunId,
    revisionNumber: 1,
    canonicalGraph: '{}',
    fingerprint: 'fp',
    status: 'active',
    now: NOW,
  });
  return { store, db, ticketId, graphRunId, revisionId };
}

describe('graph-run read helpers (NDL-60)', () => {
  it('reads the narrowed graph-run columns', () => {
    const h = harness();
    expect(graphRunStatus(h.db, h.graphRunId)).toBe('running');
    expect(graphRunStatus(h.db, 9999)).toBeUndefined();
    expect(graphRunStatusForTicket(h.db, h.graphRunId, h.ticketId)).toBe('running');
    expect(graphRunStatusForTicket(h.db, h.graphRunId, h.ticketId + 1)).toBeUndefined();
    expect(graphRunTicketId(h.db, h.graphRunId)).toBe(h.ticketId);
    expect(graphRunApproachId(h.db, h.graphRunId)).toBe('karst-graph-engineering');
    expect(graphRunIdStatusBlockedReason(h.db, h.graphRunId)).toMatchObject({
      id: h.graphRunId,
      status: 'running',
      blocked_reason: null,
    });
    expect(graphRunNodeRunCount(h.db, h.graphRunId)).toBe(0);
    expect(graphRunExpertRunCount(h.db, h.graphRunId)).toBe(0);
    expect(latestGraphRunForTicket(h.db, h.ticketId)).toMatchObject({
      id: h.graphRunId,
      stage_attempt: 1,
      approach_id: 'karst-graph-engineering',
      status: 'running',
    });
  });

  it('answers existence, marker and successor questions', () => {
    const h = harness();
    expect(graphRunExistsForTicket(h.db, h.ticketId)).toBe(true);
    expect(graphRunExistsForTicket(h.db, h.ticketId + 1)).toBe(false);
    expect(graphMarkerReadyForTicket(h.db, h.ticketId)).toBe(false);
    expect(nextGraphRunIdForTicketAfter(h.db, h.ticketId, h.graphRunId)).toBeUndefined();
    const later = Number(
      h.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 2, 'karst-graph-engineering', 'planning', ?)`,
        )
        .run(h.ticketId, NOW).lastInsertRowid,
    );
    expect(nextGraphRunIdForTicketAfter(h.db, h.ticketId, h.graphRunId)).toBe(later);
    h.db
      .prepare("UPDATE approach_graph_runs SET status = 'completed-awaiting-impl-marker' WHERE id = ?")
      .run(h.graphRunId);
    expect(graphMarkerReadyForTicket(h.db, h.ticketId)).toBe(true);
  });

  it('lists project-scoped runs and the handoff selection', () => {
    const h = harness();
    expect(runningGraphRunIdsForProject(h.db, 1)).toEqual([h.graphRunId]);
    expect(runningGraphRunIdsForProject(h.db, 2)).toEqual([]);
    // A graph ticket parked at a driver gate with no active run is handed off.
    h.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(h.ticketId);
    h.db
      .prepare(
        "INSERT INTO stages (ticket_id, stage_key, status, blocked_kind) VALUES (?, 'uat', 'running', NULL)",
      )
      .run(h.ticketId);
    // Still active → not handed off.
    expect(
      ticketIdsAwaitingGraphDrive(h.db, {
        projectId: 1,
        stageKeys: ['uat', 'review'],
        activeStatuses: ['running', 'planning'],
      }),
    ).toEqual([]);
    h.db.prepare("UPDATE approach_graph_runs SET status = 'closed' WHERE id = ?").run(h.graphRunId);
    expect(
      ticketIdsAwaitingGraphDrive(h.db, {
        projectId: 1,
        stageKeys: ['uat', 'review'],
        activeStatuses: ['running', 'planning'],
      }),
    ).toEqual([h.ticketId]);
  });

  it('reads the diagnostic reference', () => {
    const h = harness();
    expect(graphRunDiagnosticRef(h.db, h.graphRunId)).toEqual({
      stageAttempt: 1,
      ticket: 'T-1',
      project: 'p1',
    });
    expect(graphRunDiagnosticRef(h.db, 9999)).toBeUndefined();
  });
});

describe('node-run read helpers (NDL-60)', () => {
  it('reads visit numbers, latest ids and counts', () => {
    const h = harness();
    expect(nextVisitNumber(h.db, h.revisionId, 'n1')).toBe(1);
    const first = createNodeRun(h.db, {
      graphRunId: h.graphRunId,
      revisionId: h.revisionId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
      now: NOW,
    });
    h.db.prepare("UPDATE approach_node_runs SET status = 'completed', outcome = 'complete' WHERE id = ?").run(first);
    expect(nextVisitNumber(h.db, h.revisionId, 'n1')).toBe(2);
    expect(latestNodeRunIdForRevisionNode(h.db, h.revisionId, 'n1')).toBe(first);
    expect(nodeRunStatus(h.db, first)).toBe('completed');
    expect(countNodeRunsForRevisionNode(h.db, h.revisionId, 'n1')).toBe(1);
    expect(countNodeRunsForRevisionNodeByOutcome(h.db, h.revisionId, 'n1', 'complete')).toBe(1);
    expect(countNodeRunsForRevisionNodeByOutcome(h.db, h.revisionId, 'n1', 'blocked')).toBe(0);
    expect(countNodeRunsInStatusesForGraphRun(h.db, h.graphRunId, ['completed'])).toBe(1);
    expect(countNodeRunsInStatusesForGraphRun(h.db, h.graphRunId, ['running'])).toBe(0);
  });

  it('reads runnable rows, the graph-run listing and base heads', () => {
    const h = harness();
    const ready = createNodeRun(h.db, {
      graphRunId: h.graphRunId,
      revisionId: h.revisionId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
      now: NOW,
    });
    const blocked = createNodeRun(h.db, {
      graphRunId: h.graphRunId,
      revisionId: h.revisionId,
      nodeId: 'n2',
      nodeKind: 'agent',
      visitNumber: 1,
      now: NOW,
    });
    h.db.prepare("UPDATE approach_node_runs SET status = 'blocked' WHERE id = ?").run(blocked);
    expect(runnableNodeRunsForGraphRun(h.db, h.graphRunId).map((r) => r.id)).toEqual([ready]);
    expect(nodeRunsForGraphRun(h.db, h.graphRunId).map((r) => r.id)).toEqual([ready, blocked]);
    writeNodeRunBaseHeads(h.db, ready, [{ domainKey: 'd1', commit: 'abc' }]);
    expect(nodeRunBaseHeads(h.db, ready)).toEqual([{ domainKey: 'd1', commit: 'abc' }]);
  });
});

describe('planner-run read helpers (NDL-60)', () => {
  it('reads planner-run identity, attempts and listings', () => {
    const h = harness();
    expect(nextPlannerRunNumber(h.db, h.graphRunId)).toBe(1);
    const first = createPlannerRun(h.db, {
      graphRunId: h.graphRunId,
      plannerRunNumber: 1,
      kind: 'bootstrap',
    });
    const second = createPlannerRun(h.db, {
      graphRunId: h.graphRunId,
      plannerRunNumber: 2,
      kind: 'replan',
    });
    expect(nextPlannerRunNumber(h.db, h.graphRunId)).toBe(3);
    expect(plannerRunStatus(h.db, first)).toBe('ready');
    expect(plannerRunGraphRunId(h.db, first)).toBe(h.graphRunId);
    expect(plannerRunCompileAttempt(h.db, first)).toBe(0);
    expect(plannerRunIdsForGraphRun(h.db, h.graphRunId)).toEqual([second, first]);
    expect(latestPlannerRunForGraphRunKind(h.db, h.graphRunId, 'replan')!.id).toBe(second);
    expect(submittedPlannerRunForGraphRun(h.db, h.graphRunId, 'bootstrap')).toBeUndefined();
    h.db
      .prepare("UPDATE approach_planner_runs SET status = 'submitted', graph_snapshot_id = 's1' WHERE id = ?")
      .run(first);
    expect(submittedPlannerRunForGraphRun(h.db, h.graphRunId, 'bootstrap')).toMatchObject({
      id: first,
      status: 'submitted',
      graph_snapshot_id: 's1',
    });
    // A `ready` replan planner still owes a submission.
    expect(hasLiveReplanPlanner(h.db, h.graphRunId)).toBe(true);
    h.db.prepare("UPDATE approach_planner_runs SET status = 'stale' WHERE id = ?").run(second);
    expect(hasLiveReplanPlanner(h.db, h.graphRunId)).toBe(false);
    h.db.prepare("UPDATE approach_planner_runs SET status = 'running' WHERE id = ?").run(second);
    expect(hasLiveReplanPlanner(h.db, h.graphRunId)).toBe(true);
  });
});
