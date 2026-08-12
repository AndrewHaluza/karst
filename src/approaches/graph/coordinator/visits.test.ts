/**
 * Visit allocation and loop budgets (Slice 4 Task 1).
 *
 * Three visits of one node produce three distinct node runs; the fourth is
 * refused at `maxVisits: 3` with no row written. A gate visit consumes budget.
 * A refused visit with a declared failure edge routes deterministically; a
 * join, or a node with no declared edge, blocks with `graph-budget-exhausted`.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import { insertEntryTokens, insertGraphToken, type GraphTokenRow } from '../../../store/graph/tokens.js';
import { budgetRefusalFor, handleBudgetRefusal, type BudgetRefusalDeps } from './visits.js';
import { claimActivation, claimJoinActivation } from './claim.js';
import { parseGraphDocument } from '../parse.js';

/** A small canonical document: entry → a (agent, maxVisits, blocked edge to
 *  b) and b → END, plus a gate node the tests can claim directly. */
function canonical(over: {
  maxVisits?: number;
  maxNodeRuns?: number;
  aOutcomes?: string[];
  declareBlockedEdge?: boolean;
} = {}): string {
  const doc = {
    version: 1,
    title: 'loops',
    rationaleArtifact: 'rationale',
    entries: ['a'],
    artifacts: [
      { id: 'rationale', path: 'artifacts/rationale.md', producer: '$planner', consumers: ['a'], mediaType: 'text/markdown', maxBytes: 10240, required: true },
      { id: 'instructions', path: 'artifacts/instructions.md', producer: '$planner', consumers: ['a', 'b'], mediaType: 'text/markdown', maxBytes: 10240, required: true },
    ],
    nodes: [
      { id: 'a', kind: 'agent', label: 'A', profile: 'worker', instructionsArtifact: 'instructions', inputs: [], outputs: [], resources: { reads: [], writes: [] }, outcomes: over.aOutcomes ?? ['complete', 'blocked'], budget: { maxVisits: over.maxVisits ?? 3 } },
      { id: 'b', kind: 'agent', label: 'B', profile: 'worker', instructionsArtifact: 'instructions', inputs: [], outputs: [], resources: { reads: [], writes: [] }, outcomes: ['complete'], budget: { maxVisits: 3 } },
      { id: 'g', kind: 'gate', label: 'G', policy: { kind: 'node-visits', node: 'a', op: 'gte', value: 1 }, outcomes: ['matched', 'not-matched'], budget: { maxVisits: 3 } },
    ],
    edges: [
      { id: 'e-entry', from: 'a', on: 'entry', to: 'a' },
      ...(over.declareBlockedEdge ?? true
        ? [{ id: 'e-blocked', from: 'a', on: 'blocked', to: 'b' }]
        : []),
      { id: 'e-complete', from: 'a', on: 'complete', to: 'END' },
      { id: 'e-b-complete', from: 'b', on: 'complete', to: 'END' },
      { id: 'e-g', from: 'g', on: 'matched', to: 'END' },
    ],
    budgets: { maxNodeRuns: over.maxNodeRuns ?? 40, maxExpertRuns: 5, maxReplans: 2 },
  };
  const parsed = parseGraphDocument(JSON.stringify(doc));
  if (!parsed.ok) throw new Error(`fixture doc invalid: ${parsed.diagnostics[0]?.message}`);
  return JSON.stringify(doc);
}

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  makeDeps: (overrides?: Partial<BudgetRefusalDeps>) => BudgetRefusalDeps;
  graphRunId: number;
  revisionId: number;
  now: string;
}

function setup(db: ReturnType<typeof openStore>['db'], over: { maxVisits?: number; maxNodeRuns?: number; declareBlockedEdge?: boolean } = {}): { graphRunId: number; revisionId: number } {
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
         VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, canonical(over))
      .lastInsertRowid,
  );
  return { graphRunId, revisionId };
}

function withImmediate<T>(db: ReturnType<typeof openStore>['db'], fn: () => T): T {
  const runner = (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
    fn,
    { begin: 'immediate' },
  );
  return runner();
}

function harness(over: { maxVisits?: number; maxNodeRuns?: number; declareBlockedEdge?: boolean } = {}): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const { graphRunId, revisionId } = setup(db, over);
  const now = '2026-08-12T00:00:00.000Z';
  const base: BudgetRefusalDeps = {
    db,
    transaction: <T>(fn: () => T): T => withImmediate(db, fn),
    now: () => now,
  };
  return { db, makeDeps: (o) => ({ ...base, ...o }), graphRunId, revisionId, now };
}

/** N pending arrivals for node `a`, as separate tokens (distinct edge ids). */
function arrivalsForA(ctx: Ctx, n: number): GraphTokenRow[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(insertEntryTokens(ctx.db, ctx.revisionId, [{ edgeId: `entry-${i}`, destinationNodeId: 'a', destinationEnd: false }], ctx.now)[0]!);
  }
  return ids.map((id) => ctx.db.prepare('SELECT * FROM approach_graph_tokens WHERE id = ?').get(id) as GraphTokenRow);
}

function claimToken(ctx: Ctx, tokenId: number, nodeKind: 'agent' | 'gate' = 'agent') {
  return claimActivation(
    { db: ctx.db, transaction: ctx.makeDeps().transaction, now: () => ctx.now },
    { tokenId, nodeKind, profileIsExpert: false },
  );
}

describe('budgetRefusalFor', () => {
  it('refuses the fourth visit at maxVisits 3 and leaves no run behind', () => {
    const ctx = harness({ maxVisits: 3 });
    const tokens = arrivalsForA(ctx, 4);
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = claimToken(ctx, tokens[i]!.id);
      expect(result.claimed).toBe(true);
      if (result.claimed) runs.push(result.nodeRunId);
    }
    expect(new Set(runs).size).toBe(3);
    expect(runs.map(() => ctx.db.prepare('SELECT id FROM approach_node_runs').all().length)).toHaveLength(3);

    const refusal = budgetRefusalFor(ctx.db, ctx.graphRunId, ctx.revisionId, 'a');
    expect(refusal).toEqual({ reason: 'max-visits', limit: 3, visitNumber: 4 });
    const fourth = claimToken(ctx, tokens[3]!.id);
    expect(fourth).toMatchObject({ claimed: false, reason: 'budget-exhausted' });
    // No fourth run was created; the three prior runs keep their evidence.
    const rows = ctx.db.prepare('SELECT node_id, visit_number FROM approach_node_runs ORDER BY id').all();
    expect(rows).toEqual([
      { node_id: 'a', visit_number: 1 },
      { node_id: 'a', visit_number: 2 },
      { node_id: 'a', visit_number: 3 },
    ]);
  });

  it('refuses once the document maxNodeRuns ceiling is reached', () => {
    const ctx = harness({ maxNodeRuns: 2 });
    const tokens = arrivalsForA(ctx, 3);
    expect(claimToken(ctx, tokens[0]!.id).claimed).toBe(true);
    expect(claimToken(ctx, tokens[1]!.id).claimed).toBe(true);
    expect(budgetRefusalFor(ctx.db, ctx.graphRunId, ctx.revisionId, 'a')).toEqual({
      reason: 'max-node-runs',
      limit: 2,
    });
    expect(claimToken(ctx, tokens[2]!.id)).toMatchObject({ claimed: false, reason: 'budget-exhausted' });
  });
});

describe('handleBudgetRefusal', () => {
  it('routes a refused agent visit along the declared blocked edge', () => {
    const ctx = harness({ maxVisits: 1, declareBlockedEdge: true });
    const tokens = arrivalsForA(ctx, 2);
    expect(claimToken(ctx, tokens[0]!.id).claimed).toBe(true);
    const outcome = handleBudgetRefusal(ctx.makeDeps(), {
      graphRunId: ctx.graphRunId,
      revisionId: ctx.revisionId,
      nodeId: 'a',
      nodeKind: 'agent',
      tokens: [tokens[1]!],
    });
    expect(outcome).toEqual({ kind: 'routed', edgeId: 'e-blocked', destinationNodeId: 'b' });
    const cancelled = ctx.db.prepare("SELECT status FROM approach_graph_tokens WHERE id = ?").get(tokens[1]!.id) as { status: string };
    expect(cancelled.status).toBe('cancelled');
    const successor = ctx.db
      .prepare("SELECT destination_node_id, status, edge_id FROM approach_graph_tokens WHERE edge_id = 'e-blocked'")
      .all() as { destination_node_id: string; status: string; edge_id: string }[];
    expect(successor).toHaveLength(1);
    expect(successor[0]).toMatchObject({ destination_node_id: 'b', status: 'pending' });
  });

  it('blocks with graph-budget-exhausted when no failure edge is declared — never routes', () => {
    const ctx = harness({ maxVisits: 1, declareBlockedEdge: false });
    const tokens = arrivalsForA(ctx, 2);
    expect(claimToken(ctx, tokens[0]!.id).claimed).toBe(true);
    const outcome = handleBudgetRefusal(ctx.makeDeps(), {
      graphRunId: ctx.graphRunId,
      revisionId: ctx.revisionId,
      nodeId: 'a',
      nodeKind: 'agent',
      tokens: [tokens[1]!],
    });
    expect(outcome).toEqual({ kind: 'blocked' });
    const run = ctx.db.prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?').get(ctx.graphRunId) as { status: string; blocked_reason: string };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toBe('graph-budget-exhausted');
    // The arrival stays pending — Resume re-evaluates, it is never dropped.
    expect((ctx.db.prepare('SELECT status FROM approach_graph_tokens WHERE id = ?').get(tokens[1]!.id) as { status: string }).status).toBe('pending');
  });

  it('a join refusal always blocks — a join has no failure outcome', () => {
    const ctx = harness({ maxVisits: 1, declareBlockedEdge: true });
    const tokens = arrivalsForA(ctx, 1);
    const outcome = handleBudgetRefusal(ctx.makeDeps(), {
      graphRunId: ctx.graphRunId,
      revisionId: ctx.revisionId,
      nodeId: 'a',
      nodeKind: 'join',
      tokens,
    });
    expect(outcome).toEqual({ kind: 'blocked' });
  });

  it('a gate visit consumes budget (node_run_count increments)', () => {
    const ctx = harness({});
    const tokenId = insertEntryTokens(ctx.db, ctx.revisionId, [{ edgeId: 'g-arrival', destinationNodeId: 'g', destinationEnd: false }], ctx.now)[0]!;
    const result = claimToken(ctx, tokenId, 'gate');
    expect(result.claimed).toBe(true);
    const counters = ctx.db.prepare('SELECT node_run_count FROM approach_graph_runs WHERE id = ?').get(ctx.graphRunId) as { node_run_count: number };
    expect(counters.node_run_count).toBe(1);
    // A gate join firing counts the join visit too.
    const j = claimJoinActivation(
      { db: ctx.db, transaction: ctx.makeDeps().transaction, now: () => ctx.now },
      {
        tokenIds: [insertEntryTokens(ctx.db, ctx.revisionId, [{ edgeId: 'j-arrival', destinationNodeId: 'g', destinationEnd: false }], ctx.now)[0]!],
        outgoing: { edgeId: 'e-g', destinationNodeId: 'END', destinationEnd: true, forkInstance: 0, forkLineage: 'root' },
      },
    );
    expect(j.claimed).toBe(true);
    const after = ctx.db.prepare('SELECT node_run_count FROM approach_graph_runs WHERE id = ?').get(ctx.graphRunId) as { node_run_count: number };
    expect(after.node_run_count).toBe(2);
  });
});
