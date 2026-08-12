/**
 * Gate node executor tests (Slice 3 Task 4).
 *
 * The closed predicate set over persisted state, evaluated with the closed
 * comparison operators: node-visits, node-outcomes, expert-runs,
 * artifact-exists, and all/any composition. No expression executes.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import {
  evaluateGate,
  evaluateGatePredicate,
  gateStateFromStore,
  type GateState,
} from './gate.js';
import type { GatePredicate } from '../parse.js';

function state(overrides: Partial<GateState> = {}): GateState {
  return {
    nodeVisitCount: () => 0,
    nodeOutcomeCount: () => 0,
    expertRunCount: () => 0,
    artifactExists: () => false,
    ...overrides,
  };
}

describe('evaluateGatePredicate', () => {
  it('evaluates node-visits with every closed comparison operator', () => {
    const actual = 2;
    const cases: { op: 'lt' | 'lte' | 'eq' | 'gte' | 'gt'; expected: boolean }[] = [
      { op: 'lt', expected: false },
      { op: 'lte', expected: true },
      { op: 'eq', expected: true },
      { op: 'gte', expected: true },
      { op: 'gt', expected: false },
    ];
    for (const c of cases) {
      const p: GatePredicate = { kind: 'node-visits', node: 'a', op: c.op, value: actual };
      expect(evaluateGatePredicate(p, state({ nodeVisitCount: () => actual }))).toBe(c.expected);
    }
  });

  it('evaluates node-outcomes over the node run outcome counts', () => {
    const p: GatePredicate = { kind: 'node-outcomes', node: 'a', outcome: 'blocked', op: 'gte', value: 1 };
    expect(evaluateGatePredicate(p, state({ nodeOutcomeCount: () => 1 }))).toBe(true);
    expect(evaluateGatePredicate(p, state({ nodeOutcomeCount: () => 0 }))).toBe(false);
  });

  it('evaluates expert-runs against the graph run counter', () => {
    const p: GatePredicate = { kind: 'expert-runs', op: 'lte', value: 3 };
    expect(evaluateGatePredicate(p, state({ expertRunCount: () => 2 }))).toBe(true);
    expect(evaluateGatePredicate(p, state({ expertRunCount: () => 4 }))).toBe(false);
  });

  it('evaluates artifact-exists over the artifact instances', () => {
    const p: GatePredicate = { kind: 'artifact-exists', artifact: 'test-report' };
    expect(evaluateGatePredicate(p, state({ artifactExists: () => true }))).toBe(true);
    expect(evaluateGatePredicate(p, state({ artifactExists: () => false }))).toBe(false);
  });

  it('composes all and any over nested predicates', () => {
    const a: GatePredicate = { kind: 'node-visits', node: 'a', op: 'gte', value: 1 };
    const b: GatePredicate = { kind: 'expert-runs', op: 'eq', value: 0 };
    const all: GatePredicate = { kind: 'all', predicates: [a, b] };
    const any: GatePredicate = { kind: 'any', predicates: [a, b] };
    expect(evaluateGatePredicate(all, state({ nodeVisitCount: () => 1, expertRunCount: () => 0 }))).toBe(true);
    expect(evaluateGatePredicate(all, state({ nodeVisitCount: () => 0, expertRunCount: () => 0 }))).toBe(false);
    expect(evaluateGatePredicate(any, state({ nodeVisitCount: () => 0, expertRunCount: () => 5 }))).toBe(false);
    expect(evaluateGatePredicate(any, state({ nodeVisitCount: () => 0, expertRunCount: () => 0 }))).toBe(true);
    expect(evaluateGatePredicate(any, state({ nodeVisitCount: () => 1, expertRunCount: () => 5 }))).toBe(true);
  });

  it('evaluateGate maps to matched / not-matched', () => {
    const p: GatePredicate = { kind: 'artifact-exists', artifact: 'x' };
    expect(evaluateGate(p, state({ artifactExists: () => true }))).toBe('matched');
    expect(evaluateGate(p, state({ artifactExists: () => false }))).toBe('not-matched');
  });
});

describe('gateStateFromStore', () => {
  function harness(): { db: ReturnType<typeof openStore>['db']; graphRunId: number; revisionId: number } {
    const store = openStore(':memory:');
    const db = store.db;
    const ticketId = Number(
      db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    const graphRunId = Number(
      db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId)
        .lastInsertRowid,
    );
    const revisionId = Number(
      db
        .prepare(
          `INSERT INTO approach_graph_revisions
             (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
           VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
        )
        .run(graphRunId)
        .lastInsertRowid,
    );
    return { db, graphRunId, revisionId };
  }

  it('reads visit counts, outcome counts, expert runs and artifact existence', () => {
    const { db, graphRunId, revisionId } = harness();
    db.prepare(
      `INSERT INTO approach_node_runs
         (graph_run_id, revision_id, node_id, node_kind, visit_number, status, outcome)
       VALUES (?, ?, 'a', 'agent', 1, 'completed', 'blocked')`,
    ).run(graphRunId, revisionId);
    db.prepare(
      `INSERT INTO approach_node_runs
         (graph_run_id, revision_id, node_id, node_kind, visit_number, status, outcome)
       VALUES (?, ?, 'a', 'agent', 2, 'completed', 'complete')`,
    ).run(graphRunId, revisionId);
    db.prepare('UPDATE approach_graph_runs SET expert_run_count = 2 WHERE id = ?').run(graphRunId);
    db.prepare(
      `INSERT INTO approach_artifact_instances
         (graph_run_id, revision_id, artifact_id, snapshot_path, sha256, media_type, byte_size, created_at)
       VALUES (?, ?, 'report', '/snap/x', 'x', 'text/markdown', 1, ?)`,
    ).run(graphRunId, revisionId, '2026-08-12T00:00:00.000Z');

    const gs = gateStateFromStore(db, graphRunId, revisionId);
    expect(gs.nodeVisitCount('a')).toBe(2);
    expect(gs.nodeOutcomeCount('a', 'blocked')).toBe(1);
    expect(gs.nodeOutcomeCount('a', 'complete')).toBe(1);
    expect(gs.nodeOutcomeCount('a', 'replan')).toBe(0);
    expect(gs.expertRunCount()).toBe(2);
    expect(gs.artifactExists('report')).toBe(true);
    expect(gs.artifactExists('missing')).toBe(false);
  });
});
