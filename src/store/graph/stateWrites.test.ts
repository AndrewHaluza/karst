/**
 * NDL-38 — the single persistence boundary for the three graph-run tables.
 * These tests pin the store's write helpers directly (the graph runtime's own
 * suites exercise them through their callers; this file is the contract).
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import {
  clearGraphRunBlocked,
  decrementExpertRunCount,
  decrementNodeRunCount,
  deleteGraphRunData,
  graphRunById,
  graphRunIdsForTicket,
  incrementExpertRunCount,
  incrementNodeRunCount,
  incrementReplanCount,
  markGraphRunBlocked,
  releaseCommandProcessSlot,
  releaseGraphProcessSlot,
  setGraphRunCompletedAt,
} from './graphRuns.js';
import {
  claimNodeRunIntegrating,
  clearNodeRunLaunchIdentity,
  completeNodeRunIntegration,
  createNodeRun,
  incrementNodeRunLaunchAttempt,
  insertReservedNodeRun,
  nodeRunById,
  setNodeRunBudgetBlock,
  setNodeRunEndedAt,
  setNodeRunFailure,
  setNodeRunLaunchIdentity,
  setNodeRunOutcome,
  setNodeRunPromptHash,
  setNodeRunReason,
  setNodeRunTerminalFields,
} from './nodeRuns.js';
import {
  createPlannerRun,
  markPlannerRunStarted,
  plannerRunById,
  setPlannerRunCompileAttempt,
  setPlannerRunEndedAt,
  setPlannerRunGraphSnapshot,
  setPlannerRunLaunchIdentity,
  setPlannerRunPromptHashArtifact,
  setPlannerRunReason,
  setPlannerRunReasonEndedAt,
  setPlannerRunSubmittedSnapshot,
} from './plannerRuns.js';
import { createRevision } from './revisions.js';

const NOW = '2026-09-28T00:00:00.000Z';

interface Harness {
  store: ReturnType<typeof openStore>;
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
}

function harness(): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', ?)`,
      )
      .run(ticketId, NOW).lastInsertRowid,
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

function nodeRun(h: Harness, status = 'running'): number {
  const id = createNodeRun(h.db, {
    graphRunId: h.graphRunId,
    revisionId: h.revisionId,
    nodeId: 'n1',
    nodeKind: 'agent',
    visitNumber: 1,
    now: NOW,
  });
  h.db.prepare('UPDATE approach_node_runs SET status = ? WHERE id = ?').run(status, id);
  return id;
}

describe('graph-run write boundary (NDL-38)', () => {
  it('writes the graph-run state columns only through the store', () => {
    const h = harness();
    markGraphRunBlocked(h.db, h.graphRunId, 'graph-topology-deadlock', NOW);
    expect(graphRunById(h.db, h.graphRunId)).toMatchObject({
      status: 'running',
      blocked_reason: 'graph-topology-deadlock',
      updated_at: NOW,
    });
    clearGraphRunBlocked(h.db, h.graphRunId, NOW);
    expect(graphRunById(h.db, h.graphRunId)!.blocked_reason).toBeNull();
    incrementReplanCount(h.db, h.graphRunId, NOW);
    expect(graphRunById(h.db, h.graphRunId)!.replan_count).toBe(1);
    setGraphRunCompletedAt(h.db, h.graphRunId, NOW);
    expect(graphRunById(h.db, h.graphRunId)!.completed_at).toBe(NOW);
  });

  it('keeps the node/expert budget counters from going negative', () => {
    const h = harness();
    expect(decrementNodeRunCount(h.db, h.graphRunId, NOW)).toBe(false);
    incrementNodeRunCount(h.db, h.graphRunId, NOW);
    incrementExpertRunCount(h.db, h.graphRunId, NOW);
    expect(graphRunById(h.db, h.graphRunId)).toMatchObject({
      node_run_count: 1,
      expert_run_count: 1,
    });
    expect(decrementNodeRunCount(h.db, h.graphRunId, NOW)).toBe(true);
    expect(decrementExpertRunCount(h.db, h.graphRunId, NOW)).toBe(true);
    expect(graphRunById(h.db, h.graphRunId)).toMatchObject({
      node_run_count: 0,
      expert_run_count: 0,
    });
  });

  it('releases a command node slot only for command runs', () => {
    const h = harness();
    const id = nodeRun(h);
    incrementNodeRunCount(h.db, h.graphRunId, NOW);
    expect(releaseCommandProcessSlot(h.db, id, NOW)).toBe(false);
    h.db.prepare("UPDATE approach_node_runs SET node_kind = 'command' WHERE id = ?").run(id);
    expect(releaseCommandProcessSlot(h.db, id, NOW)).toBe(true);
    expect(releaseGraphProcessSlot(h.db, h.graphRunId, NOW)).toBe(true);
    expect(graphRunById(h.db, h.graphRunId)!.active_processes).toBe(0);
  });

  it('deletes every graph-run row leaf-first', () => {
    const h = harness();
    createPlannerRun(h.db, { graphRunId: h.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    nodeRun(h);
    expect(graphRunIdsForTicket(h.db, h.ticketId)).toEqual([h.graphRunId]);
    deleteGraphRunData(h.db, h.graphRunId);
    expect(graphRunById(h.db, h.graphRunId)).toBeUndefined();
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM approach_node_runs').get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('node-run write boundary (NDL-38)', () => {
  it('writes a reserved run without a started_at until launch', () => {
    const h = harness();
    const id = insertReservedNodeRun(h.db, {
      graphRunId: h.graphRunId,
      revisionId: h.revisionId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
    });
    expect(nodeRunById(h.db, id)).toMatchObject({ status: 'ready', started_at: null });
  });

  it('records launch identity, retries, and the terminal outcome', () => {
    const h = harness();
    const id = nodeRun(h);
    setNodeRunPromptHash(h.db, id, 'hash');
    expect(nodeRunById(h.db, id)!.prompt_hash).toBe('hash');
    setNodeRunLaunchIdentity(h.db, id, {
      generation: 'g1',
      capabilityHash: 'cap',
      ownerNonce: 'nonce',
    });
    expect(nodeRunById(h.db, id)).toMatchObject({
      generation: 'g1',
      capability_hash: 'cap',
      owner_nonce: 'nonce',
    });
    clearNodeRunLaunchIdentity(h.db, id);
    expect(nodeRunById(h.db, id)).toMatchObject({
      generation: null,
      owner_nonce: null,
      process_run_id: null,
    });
    incrementNodeRunLaunchAttempt(h.db, id);
    expect(nodeRunById(h.db, id)!.launch_attempt).toBe(1);
    setNodeRunReason(h.db, id, 'retry');
    setNodeRunOutcome(h.db, id, 'complete', NOW);
    expect(nodeRunById(h.db, id)).toMatchObject({ reason: 'retry', outcome: 'complete', ended_at: NOW });
  });

  it('parks a launch failure and the integration terminal fields', () => {
    const h = harness();
    const id = nodeRun(h, 'launching');
    setNodeRunFailure(h.db, id, { failureCategory: 'failed-to-launch', reason: 'boom', now: NOW });
    expect(nodeRunById(h.db, id)).toMatchObject({
      failure_category: 'failed-to-launch',
      reason: 'boom',
      ended_at: NOW,
    });
    setNodeRunEndedAt(h.db, id, NOW);
    setNodeRunTerminalFields(h.db, id, { outcome: 'blocked', reason: 'late' });
    expect(nodeRunById(h.db, id)).toMatchObject({
      outcome: 'blocked',
      failure_category: null,
      reason: 'late',
    });
  });

  it('scopes the replan budget block to the node run graph', () => {
    const h = harness();
    const id = nodeRun(h);
    expect(setNodeRunBudgetBlock(h.db, id, h.graphRunId + 1, 'graph-budget-exhausted')).toBe(false);
    expect(setNodeRunBudgetBlock(h.db, id, h.graphRunId, 'graph-budget-exhausted')).toBe(true);
    expect(nodeRunById(h.db, id)).toMatchObject({
      effective_outcome: 'blocked',
      failure_category: 'graph-budget-exhausted',
    });
  });

  it('claims integrating and accepts the integration', () => {
    const h = harness();
    const id = nodeRun(h, 'completing');
    expect(claimNodeRunIntegrating(h.db, id)).toBe(true);
    expect(completeNodeRunIntegration(h.db, id, 'cs:1:1', NOW)).toBe(true);
    expect(nodeRunById(h.db, id)).toMatchObject({
      status: 'integrating',
      outcome: 'complete',
      effective_outcome: 'complete',
      change_set_id: 'cs:1:1',
      ended_at: NOW,
    });
  });
});

describe('planner-run write boundary (NDL-38)', () => {
  it('records identity, prompt, snapshots, attempts and terminal state', () => {
    const h = harness();
    const id = createPlannerRun(h.db, {
      graphRunId: h.graphRunId,
      plannerRunNumber: 1,
      kind: 'bootstrap',
    });
    setPlannerRunPromptHashArtifact(h.db, id, 'ph', 'prompts/ph');
    expect(plannerRunById(h.db, id)).toMatchObject({
      prompt_hash: 'ph',
      artifact_snapshot_id: 'prompts/ph',
    });
    setPlannerRunGraphSnapshot(h.db, id, 'snap');
    expect(plannerRunById(h.db, id)!.graph_snapshot_id).toBe('snap');
    setPlannerRunSubmittedSnapshot(h.db, id, 'snap2', NOW);
    expect(plannerRunById(h.db, id)).toMatchObject({ graph_snapshot_id: 'snap2', submitted_at: NOW });
    setPlannerRunLaunchIdentity(h.db, id, {
      generation: 'g',
      capabilityHash: 'c',
      ownerNonce: 'o',
    });
    markPlannerRunStarted(h.db, id, NOW);
    expect(plannerRunById(h.db, id)).toMatchObject({
      generation: 'g',
      capability_hash: 'c',
      owner_nonce: 'o',
      started_at: NOW,
    });
    setPlannerRunCompileAttempt(h.db, id, 2);
    setPlannerRunReason(h.db, id, 'r');
    setPlannerRunEndedAt(h.db, id, NOW);
    setPlannerRunReasonEndedAt(h.db, id, 'r2', NOW);
    expect(plannerRunById(h.db, id)).toMatchObject({
      compile_attempt: 2,
      reason: 'r2',
      ended_at: NOW,
    });
  });

  it('keeps the first started_at on a re-prompted planner', () => {
    const h = harness();
    const id = createPlannerRun(h.db, {
      graphRunId: h.graphRunId,
      plannerRunNumber: 1,
      kind: 'bootstrap',
    });
    markPlannerRunStarted(h.db, id, '2026-09-01T00:00:00.000Z');
    markPlannerRunStarted(h.db, id, NOW);
    expect(plannerRunById(h.db, id)!.started_at).toBe('2026-09-01T00:00:00.000Z');
  });
});
