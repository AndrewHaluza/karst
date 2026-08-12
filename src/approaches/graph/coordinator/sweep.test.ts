/**
 * Coordinator sweep (Slice 3 Task 2).
 *
 * A bounded periodic reconciliation re-reads canonical state and claims
 * activations — never depending on a wake-up, so a completion that committed
 * to the database is always eventually scheduled even when its callback hit
 * a dead port. One tick claims deterministically (oldest tokens first),
 * fires joins when their full arrival set is pending, and is bounded to
 * ≤ 100 state transitions.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import {
  insertEntryTokens,
  insertGraphToken,
  graphTokenById,
  pendingTokensForRevision,
} from '../../../store/graph/tokens.js';
import { runCoordinatorTick, type SweepDeps } from './sweep.js';
import type { GraphDocument, ApproachEdge, ApproachNode } from '../parse.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  makeDeps: (overrides?: Partial<SweepDeps>) => SweepDeps;
  graphRunId: number;
  revisionId: number;
  now: string;
}

function doc(nodes: ApproachNode[], edges: ApproachEdge[], entries: string[]): string {
  const document: GraphDocument = {
    version: 1,
    title: 't',
    rationaleArtifact: 'rationale',
    entries,
    artifacts: [],
    nodes,
    edges,
    budgets: { maxNodeRuns: 100, maxExpertRuns: 10, maxReplans: 1 },
  };
  return JSON.stringify(document);
}

function agent(id: string, maxVisits = 3): ApproachNode {
  return {
    id,
    kind: 'agent',
    label: id,
    profile: 'worker',
    instructionsArtifact: 'instr',
    inputs: [],
    outputs: [],
    resources: { reads: [], writes: [] },
    outcomes: ['complete'],
    budget: { maxVisits },
  };
}

function join(id: string, waitFor: string[]): ApproachNode {
  return {
    id,
    kind: 'join',
    label: id,
    forkFrom: 'f',
    waitFor,
    mode: 'all',
    outcomes: ['complete'],
    budget: { maxVisits: 3 },
  };
}

function harness(documentText: string, runStatus = 'running'): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, runStatus)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, documentText)
      .lastInsertRowid,
  );
  const now = '2026-08-12T00:00:00.000Z';
  const base: SweepDeps = {
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
        fn,
        { begin: 'immediate' },
      )(),
    now: () => now,
  };
  return {
    db,
    makeDeps: (overrides) => ({ ...base, ...overrides }),
    graphRunId,
    revisionId,
    now,
  };
}

function runIdForNode(db: Ctx['db'], revisionId: number, nodeId: string): number | undefined {
  const row = db
    .prepare(
      'SELECT id FROM approach_node_runs WHERE revision_id = ? AND node_id = ? ORDER BY id LIMIT 1',
    )
    .get(revisionId, nodeId) as { id: number } | undefined;
  return row?.id;
}

describe('runCoordinatorTick', () => {
  it('a completion whose wake-up is dropped is scheduled by the sweep', () => {
    // nodes a → b, entry → a. The entry token is claimed by tick 1; the
    // completion inserts b's successor token WITHOUT any wake-up; tick 2 must
    // find it and claim it anyway.
    const ctx = harness(doc([agent('a'), agent('b')], [
      { id: 'a-b', from: 'a', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a']));
    insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], ctx.now);
    const first = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(first.claimed).toBe(1);
    expect(first.transitions).toBeGreaterThanOrEqual(1);
    const aRunId = runIdForNode(ctx.db, ctx.revisionId, 'a');
    expect(aRunId).toBeDefined();
    insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: aRunId!,
      isEntry: false,
      edgeId: 'a-b',
      destinationNodeId: 'b',
      destinationEnd: false,
      forkInstance: 0,
      forkLineage: 'root',
      now: ctx.now,
    });
    const second = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(second.claimed).toBe(1);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'b')).toBeDefined();
  });

  it('fires a join only when its full arrival set is pending, then continues', () => {
    const ctx = harness(doc(
      [agent('f'), agent('b1'), agent('b2'), join('j', ['b1', 'b2']), agent('b')],
      [
        { id: 'f-b1', from: 'f', on: 'complete', to: 'b1' },
        { id: 'f-b2', from: 'f', on: 'complete', to: 'b2' },
        { id: 'b1-j', from: 'b1', on: 'complete', to: 'j' },
        { id: 'b2-j', from: 'b2', on: 'complete', to: 'j' },
        { id: 'j-b', from: 'j', on: 'complete', to: 'b' },
        { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
      ],
      ['f'],
    ));
    insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-f', destinationNodeId: 'f', destinationEnd: false },
    ], ctx.now);
    expect(runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId }).claimed).toBe(1);
    const fRunId = runIdForNode(ctx.db, ctx.revisionId, 'f')!;
    // Simulate f's completion: both arrivals become pending. Half a firing is
    // NOT enough — the join waits for its whole set.
    insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: fRunId,
      isEntry: false,
      edgeId: 'b1-j',
      destinationNodeId: 'j',
      destinationEnd: false,
      forkInstance: 0,
      forkLineage: 'root',
      now: ctx.now,
    });
    const partial = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(partial.claimed).toBe(0);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'j')).toBeUndefined();
    insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: fRunId,
      isEntry: false,
      edgeId: 'b2-j',
      destinationNodeId: 'j',
      destinationEnd: false,
      forkInstance: 0,
      forkLineage: 'root',
      now: ctx.now,
    });
    const firing = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(firing.claimed).toBe(1);
    const joinRunId = runIdForNode(ctx.db, ctx.revisionId, 'j');
    expect(joinRunId).toBeDefined();
    const arrivals = pendingTokensForRevision(ctx.db, ctx.revisionId);
    expect(arrivals.some((t) => t.destination_node_id === 'j')).toBe(false);
    const successor = ctx.db
      .prepare('SELECT destination_node_id, status FROM approach_graph_tokens WHERE edge_id = ?')
      .get('j-b') as { destination_node_id: string; status: string };
    expect(successor).toMatchObject({ destination_node_id: 'b', status: 'pending' });
    expect(runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId }).claimed).toBe(1);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'b')).toBeDefined();
  });

  it('is bounded to 100 transitions per tick', () => {
    // 150 pending tokens across five nodes of maxVisits 20 (the hard
    // ceiling): the tick bound (100), not the node budgets, is what stops it.
    const nodes = [agent('a'), ...Array.from({ length: 5 }, (_, i) => agent(`b${i}`, 20))];
    const ctx = harness(doc(nodes, [
      { id: 'a-b', from: 'a', on: 'complete', to: 'b0' },
      { id: 'b-end', from: 'b0', on: 'complete', to: 'END' },
    ], ['a']));
    // 30 pending tokens per node (distinct activations).
    for (let i = 0; i < 150; i++) {
      insertGraphToken(ctx.db, {
        revisionId: ctx.revisionId,
        sourceNodeRunId: 700 + i,
        isEntry: false,
        edgeId: `s${i}`,
        destinationNodeId: `b${i % 5}`,
        destinationEnd: false,
        forkInstance: i,
        forkLineage: 'root',
        now: ctx.now,
      });
    }
    const result = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(100);
    expect(result.transitions).toBe(100);
    const pending = pendingTokensForRevision(ctx.db, ctx.revisionId);
    expect(pending.length).toBe(50);
  });

  it('never claims END tokens and never acts on a non-running graph run', () => {
    const blocked = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']), 'blocked');
    insertEntryTokens(blocked.db, blocked.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], blocked.now);
    expect(runCoordinatorTick(blocked.makeDeps(), { graphRunId: blocked.graphRunId })).toMatchObject({
      claimed: 0,
      transitions: 0,
    });

    const running = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    insertEntryTokens(running.db, running.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], running.now);
    insertGraphToken(running.db, {
      revisionId: running.revisionId,
      sourceNodeRunId: 5,
      isEntry: false,
      edgeId: 'a-end',
      destinationNodeId: 'END',
      destinationEnd: true,
      forkInstance: 0,
      forkLineage: 'root',
      now: running.now,
    });
    const result = runCoordinatorTick(running.makeDeps(), { graphRunId: running.graphRunId });
    expect(result.claimed).toBe(1);
    const endToken = running.db
      .prepare("SELECT status FROM approach_graph_tokens WHERE edge_id = 'a-end'")
      .get() as { status: string };
    expect(endToken.status).toBe('pending');
  });

  it('a raced token claimed by another window is skipped, not thrown', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    const [tokenId] = insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], ctx.now);
    ctx.db.prepare("UPDATE approach_graph_tokens SET status = 'claimed' WHERE id = ?").run(tokenId);
    const result = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(0);
    expect(result.transitions).toBe(0);
  });
});
