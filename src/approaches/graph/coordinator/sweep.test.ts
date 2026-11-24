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
import { acquireLease, markLeaseAmbiguous } from '../../../store/graph/leases.js';
import {
  runCoordinatorTick,
  activeGraphRunIds,
  MAX_DEFERRAL_WAIT_MS,
  MAX_LIVE_HOLDER_WAIT_MS,
  type SweepDeps,
} from './sweep.js';
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

function gate(id: string): ApproachNode {
  return {
    id,
    kind: 'gate',
    label: id,
    policy: { kind: 'all', predicates: [] },
    outcomes: ['matched'],
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

/** Insert a node run at a chosen status — the sweep tests need lease owners
 *  parked in statuses the claim path never writes. */
function insertNodeRunRow(
  db: Ctx['db'],
  row: {
    graphRunId: number;
    revisionId: number;
    nodeId: string;
    status: string;
    id?: number;
    nodeKind?: 'agent' | 'command' | 'gate';
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(row.id ?? null, row.graphRunId, row.revisionId, row.nodeId, row.nodeKind ?? 'agent', row.status);
  return Number(info.lastInsertRowid);
}

/**
 * A second graph run (with its active revision) for a lease owner that must NOT
 * belong to `ctx.graphRunId`: the tick parks a run `node-blocked` as soon as
 * that run has a `blocked`/`stale` node run, so a parked cross-run lease owner
 * needs its own run — which is also how cross-run lease contention arises in
 * production.
 */
function foreignRun(ctx: Ctx): { graphRunId: number; revisionId: number } {
  const graphRunId = Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         SELECT ticket_id, 'impl',
                (SELECT COALESCE(MAX(stage_attempt), 0) + 1 FROM approach_graph_runs),
                'foreign-approach', 'running', '2026-08-12T00:00:00.000Z'
         FROM approach_graph_runs WHERE id = ?`,
      )
      .run(ctx.graphRunId).lastInsertRowid,
  );
  const revisionId = Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp-foreign', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId).lastInsertRowid,
  );
  return { graphRunId, revisionId };
}

/** A live lease owner in `ctx.graphRunId` (a `running` row is not a fault, so
 *  the run still reaches the scheduler). */
function liveOwnerInRun(ctx: Ctx, status = 'running'): number {
  return insertNodeRunRow(ctx.db, {
    graphRunId: ctx.graphRunId,
    revisionId: ctx.revisionId,
    nodeId: 'foreign-owner',
    status,
  });
}

/** A lease owner parked in a FOREIGN graph run (blocked/stale/etc.). */
function parkedOwner(ctx: Ctx, status: string): number {
  const foreign = foreignRun(ctx);
  return insertNodeRunRow(ctx.db, {
    graphRunId: foreign.graphRunId,
    revisionId: foreign.revisionId,
    nodeId: 'foreign-owner',
    status,
  });
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

  it('the first fault stops new launches — the run blocks and claims nothing (Slice 5 T6)', () => {
    const ctx = harness(doc([agent('a'), agent('b')], [
      { id: 'a-b', from: 'a', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a', 'b']));
    insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-b', destinationNodeId: 'b', destinationEnd: false },
    ], ctx.now);
    // Two concurrent node faults on a still-running run (a fault path that
    // recorded the node without blocking the run, or a raced block). The
    // EARLIEST by durable order (lowest node-run id) is 5 — the block reason
    // must name it, and the tick must claim NO new activation.
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, reason)
         VALUES (5, ?, ?, 'a', 'agent', 1, 'blocked', 'integration-conflict: a.ts')`,
      )
      .run(ctx.graphRunId, ctx.revisionId);
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, reason)
         VALUES (6, ?, ?, 'b', 'agent', 1, 'launch-unknown', 'crashed after a possible spawn')`,
      )
      .run(ctx.graphRunId, ctx.revisionId);
    const result = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result).toMatchObject({ claimed: 0, transitions: 0 });
    const run = ctx.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('node 5');
    expect(run.blocked_reason).toContain('integration-conflict: a.ts');
    expect(run.blocked_reason).not.toContain('node 6');
  });

  it('a draining revision is never scheduled — new nodes stop launching (Slice 4 T5)', () => {
    // Step 2 of immutable replanning: once the election moved the run to
    // draining, the tick must not claim the revision's pending tokens. The
    // run gate (status must be 'running') is what stops it by construction.
    const draining = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']), 'draining');
    insertEntryTokens(draining.db, draining.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], draining.now);
    expect(
      runCoordinatorTick(draining.makeDeps(), { graphRunId: draining.graphRunId }),
    ).toMatchObject({ claimed: 0, transitions: 0 });
    const pending = draining.db
      .prepare("SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(1);
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

  it('claims record the base heads the host captured for the tick (Slice 5 T1)', () => {
    const ctx = harness(doc([agent('a'), agent('b')], [
      { id: 'a-b', from: 'a', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a']));
    insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], ctx.now);
    const baseHeads = [{ domainKey: 'dk', commit: 'cafe' }];
    const result = runCoordinatorTick(ctx.makeDeps({ baseHeadsOf: () => baseHeads }), {
      graphRunId: ctx.graphRunId,
    });
    expect(result.claimed).toBe(1);
    const run = ctx.db
      .prepare('SELECT base_heads FROM approach_node_runs WHERE node_id = ?')
      .get('a') as { base_heads: string };
    expect(JSON.parse(run.base_heads)).toEqual(baseHeads);
  });

  it('claims acquire one held lease per host-resolved domain (Slice 5 T2)', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], ctx.now);
    const result = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [
        { physicalDomain: 'dom-api', accessMode: 'write' },
        { physicalDomain: 'dom-web', accessMode: 'read' },
      ],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(1);
    const runId = runIdForNode(ctx.db, ctx.revisionId, 'a');
    const leases = ctx.db
      .prepare(
        'SELECT physical_domain, status FROM approach_resource_leases WHERE owner_node_run_id = ? ORDER BY physical_domain',
      )
      .all(runId!) as { physical_domain: string; status: string }[];
    expect(leases).toEqual([
      { physical_domain: 'dom-api', status: 'held' },
      { physical_domain: 'dom-web', status: 'held' },
    ]);
  });

  it('a lease-conflicted activation defers to the next tick — the token stays pending, nothing is claimed', () => {
    const ctx = harness(doc([agent('a'), agent('b')], [
      { id: 'a-b', from: 'a', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a']));
    // A foreign node run already holds `dom-api`; node `a` needs it.
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (900, ?, ?, 'foreign', 'agent', 1, 'running')`,
      )
      .run(ctx.graphRunId, ctx.revisionId);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 900,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: ctx.now,
    });
    insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'entry-a', destinationNodeId: 'a', destinationEnd: false },
    ], ctx.now);
    const result = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write' }],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(0);
    const token = ctx.db
      .prepare("SELECT status FROM approach_graph_tokens WHERE destination_node_id = 'a'")
      .get() as { status: string };
    expect(token.status).toBe('pending'); // deferred, never cancelled
    expect(runIdForNode(ctx.db, ctx.revisionId, 'a')).toBeUndefined();
    // Once the foreign lease releases, the same tick claims it.
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'released' WHERE owner_node_run_id = 900")
      .run();
    const retry = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write' }],
    }), { graphRunId: ctx.graphRunId });
    expect(retry.claimed).toBe(1);
  });
});

describe('scheduler admission, deferrals and the process ceiling (Slice 5 Task 3)', () => {
  function entryFor(ctx: Ctx, edgeId: string, destination: string, at: string): number {
    return insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId, destinationNodeId: destination, destinationEnd: false },
    ], at)[0]!;
  }

  function deferralRow(db: Ctx['db'], nodeId: string): { reason: string; wait_since: string; updated_at: string } | undefined {
    return db
      .prepare('SELECT reason, wait_since, updated_at FROM approach_node_deferrals WHERE node_id = ?')
      .get(nodeId) as { reason: string; wait_since: string; updated_at: string } | undefined;
  }

  it('persists a deferral with its reason and wait_since when a lease conflict refuses the claim, and clears it on success', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (900, ?, ?, 'foreign', 'agent', 1, 'running')`,
      )
      .run(ctx.graphRunId, ctx.revisionId);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 900,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: ctx.now,
    });
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    const result = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(0);
    const deferral = deferralRow(ctx.db, 'a')!;
    expect(deferral.reason).toMatch(/dom-api/);
    expect(deferral.wait_since).toBe(ctx.now);
    // The lease releases; the retry claims and the deferral is cleared.
    ctx.db.prepare("UPDATE approach_resource_leases SET status = 'released' WHERE owner_node_run_id = 900").run();
    const retry = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
    }), { graphRunId: ctx.graphRunId });
    expect(retry.claimed).toBe(1);
    expect(deferralRow(ctx.db, 'a')).toBeUndefined();
  });

  it('H4: a deferral older than the ceiling blocks the run instead of waiting forever', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    // A PARKED holder (in a foreign run): a live holder keeps the long ceiling
    // (T1333), so the short 30-minute ceiling is what this test measures.
    const owner = parkedOwner(ctx, 'blocked');
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: owner,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: ctx.now,
    });
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    // The node has been deferred against a lease held by a node that will
    // never finish — the aging policy would just keep promoting it forever.
    ctx.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, 'a', 'resource-conflict: dom-api', ?, ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');

    const result = runCoordinatorTick(ctx.makeDeps({
      now: () => '2026-08-11T02:00:00.000Z',
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(0);
    const run = ctx.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
    expect(run.blocked_reason).toContain('a');
    expect(run.blocked_reason).toContain('dom-api');
  });

  it('H4: a wait that passed asleep is not a deferral timeout (T1326)', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    // A parked holder keeps the SHORT ceiling (a live one keeps the 4 hour bound, T1333).
    const owner = parkedOwner(ctx, 'blocked');
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: owner,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: ctx.now,
    });
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    ctx.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, 'a', 'resource-conflict: dom-api', ?, ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
    const at = '2026-08-11T02:00:00.000Z';
    const tick = (awakeElapsedMs: () => number) =>
      runCoordinatorTick(ctx.makeDeps({
        now: () => at,
        awakeElapsedMs,
        domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
      }), { graphRunId: ctx.graphRunId });
    const status = (): string =>
      (ctx.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(ctx.graphRunId) as { status: string }).status;

    // Two wall hours, but only ten minutes awake: the run keeps waiting.
    tick(() => 10 * 60_000);
    expect(status()).toBe('running');

    // The same wall time with the awake time actually spent blocks as before.
    tick(() => 2 * 60 * 60_000);
    expect(status()).toBe('blocked');
  });

  it('H4: a timeout whose CAS lost to a run still running keeps scheduling', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    // A parked holder in a foreign run: this test needs the SHORT ceiling to
    // reach the timeout path whose CAS it then swallows.
    const owner = parkedOwner(ctx, 'blocked');
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: owner,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: ctx.now,
    });
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    ctx.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, 'a', 'resource-conflict: dom-api', ?, ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');

    // A transaction that swallows the block (the shape of a lost CAS) while
    // the run stays `running`: the tick must NOT abandon its remaining work.
    const deps = ctx.makeDeps({
      now: () => '2026-08-11T02:00:00.000Z',
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
      transaction: <T,>(fn: () => T): T => {
        const before = ctx.db
          .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
          .get(ctx.graphRunId) as { status: string };
        const out = fn();
        ctx.db
          .prepare('UPDATE approach_graph_runs SET status = ?, blocked_reason = NULL WHERE id = ?')
          .run(before.status, ctx.graphRunId);
        return out;
      },
    });
    runCoordinatorTick(deps, { graphRunId: ctx.graphRunId });
    const run = ctx.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string };
    expect(run.status).toBe('running');
  });

  it('H4: a deferral inside the ceiling keeps waiting — the run is untouched', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (900, ?, ?, 'foreign', 'agent', 1, 'running')`,
      )
      .run(ctx.graphRunId, ctx.revisionId);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 900,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: ctx.now,
    });
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    const result = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(0);
    const run = ctx.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string };
    expect(run.status).toBe('running');
    expect(deferralRow(ctx.db, 'a')).toBeDefined();
  });

  it('a dependency-waiting join is never reported as resource-blocked — a stale deferral is cleared instead', () => {
    const ctx = harness(doc(
      [agent('f'), join('j', ['b1', 'b2']), agent('b')],
      [
        { id: 'f-j', from: 'f', on: 'complete', to: 'j' },
        { id: 'j-b', from: 'j', on: 'complete', to: 'b' },
        { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
      ],
      ['f'],
    ));
    entryFor(ctx, 'entry-f', 'f', ctx.now);
    // Simulate f's completion: only ONE of the join's two arrivals is pending.
    const fRunId = runIdForNode(ctx.db, ctx.revisionId, 'f')!;
    // f claims; complete it by hand to mint the single arrival.
    runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
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
    // A stale resource-blocked deferral from an earlier tick (wrong — the join
    // is dependency-waiting now) must be cleared, never refreshed.
    ctx.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, 'j', 'resource-conflict: stale', ?, ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, ctx.now, ctx.now);
    const result = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(0);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'j')).toBeUndefined();
    expect(deferralRow(ctx.db, 'j')).toBeUndefined();
  });

  it('path-disjoint agents run concurrently in one tick — two held leases on the same domain', () => {
    const ctx = harness(doc([agent('a'), agent('b')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a', 'b']));
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    entryFor(ctx, 'entry-b', 'b', ctx.now);
    const domainsForActivation = (nodeId: string) =>
      nodeId === 'a'
        ? [{ physicalDomain: 'dom', accessMode: 'write' as const, paths: ['src/'] }]
        : [{ physicalDomain: 'dom', accessMode: 'write' as const, paths: ['lib/'] }];
    const result = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: ({ nodeId }) => domainsForActivation(nodeId),
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(2);
    const aId = runIdForNode(ctx.db, ctx.revisionId, 'a')!;
    const bId = runIdForNode(ctx.db, ctx.revisionId, 'b')!;
    const aLease = ctx.db
      .prepare('SELECT claimed_paths FROM approach_resource_leases WHERE owner_node_run_id = ?')
      .get(aId) as { claimed_paths: string | null };
    const bLease = ctx.db
      .prepare('SELECT claimed_paths FROM approach_resource_leases WHERE owner_node_run_id = ?')
      .get(bId) as { claimed_paths: string | null };
    expect(aLease.claimed_paths).toBe('["src/"]');
    expect(bLease.claimed_paths).toBe('["lib/"]');
  });

  it('repository aliases sharing a repoPath conflict correctly — one domain, second defers', () => {
    const ctx = harness(doc(
      [agent('a'), agent('b')],
      [
        { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
        { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
      ],
      ['a', 'b'],
    ));
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    entryFor(ctx, 'entry-b', 'b', ctx.now);
    // Two manifest entries — api and api-alias — resolve to ONE domain key.
    const result = runCoordinatorTick(ctx.makeDeps({
      domainsForActivation: () => [{ physicalDomain: 'dom-x', accessMode: 'write', paths: [] }],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(1);
    const deferral = deferralRow(ctx.db, result.claimed === 1 ? (runIdForNode(ctx.db, ctx.revisionId, 'a') ? 'b' : 'a') : 'b')!;
    expect(deferral.reason).toMatch(/resource-conflict/);
  });

  it('the process ceiling refuses an agent claim with a parallel-slot-busy deferral', () => {
    const ctx = harness(doc([agent('a'), agent('b')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a', 'b']));
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    entryFor(ctx, 'entry-b', 'b', ctx.now);
    const result = runCoordinatorTick(ctx.makeDeps({
      maxParallelOf: () => 1,
      domainsForActivation: () => [],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(1);
    const slots = ctx.db
      .prepare('SELECT active_processes FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { active_processes: number };
    expect(slots.active_processes).toBe(1);
    const loser = runIdForNode(ctx.db, ctx.revisionId, 'a') ? 'b' : 'a';
    const deferral = deferralRow(ctx.db, loser)!;
    expect(deferral.reason).toMatch(/parallel-slot-busy/);
    expect(deferral.reason).toMatch(/maxParallel 1/);
  });

  it('gates and joins consume no process slot', () => {
    const ctx = harness(doc([agent('a'), gate('g'), join('j', ['g']), agent('b')], [
      { id: 'a-g', from: 'a', on: 'complete', to: 'g' },
      { id: 'g-j', from: 'g', on: 'matched', to: 'j' },
      { id: 'j-b', from: 'j', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a']));
    entryFor(ctx, 'entry-a', 'a', ctx.now);
    runCoordinatorTick(ctx.makeDeps({ maxParallelOf: () => 1 }), { graphRunId: ctx.graphRunId });
    const slots = ctx.db
      .prepare('SELECT active_processes FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { active_processes: number };
    expect(slots.active_processes).toBe(1); // only the agent claim reserved
  });

  it('wait_since is stamped on the FIRST deferral and survives later refusals (bounded aging clock)', () => {
    const ctx = harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (900, ?, ?, 'foreign', 'agent', 1, 'running')`,
      )
      .run(ctx.graphRunId, ctx.revisionId);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 900,
      physicalDomain: 'dom-api',
      accessMode: 'write',
      claimedPaths: null,
      now: '2026-08-12T00:00:00.000Z',
    });
    const t0 = '2026-08-12T00:00:00.000Z';
    const t1 = '2026-08-12T00:00:30.000Z';
    entryFor(ctx, 'entry-a', 'a', t0);
    const clock = { value: t0 };
    const deps = (): SweepDeps =>
      ctx.makeDeps({
        now: () => clock.value,
        domainsForActivation: () => [{ physicalDomain: 'dom-api', accessMode: 'write', paths: [] }],
      });
    runCoordinatorTick(deps(), { graphRunId: ctx.graphRunId });
    const first = deferralRow(ctx.db, 'a')!;
    expect(first.wait_since).toBe(t0);
    clock.value = t1;
    runCoordinatorTick(deps(), { graphRunId: ctx.graphRunId });
    const second = deferralRow(ctx.db, 'a')!;
    expect(second.wait_since).toBe(t0); // the clock never moves once stamped
    expect(second.updated_at).toBe(t1);
  });

  it('aging prevents starvation: a wide node that has waited past the threshold is preferred over older narrow work', () => {
    // maxParallel 1 with one slot. `wide`'s claim is refused by the slot while
    // its deferral accumulates; `narrow` was created EARLIER. Under pure
    // creation-time ordering `narrow` would win the freed slot — but `wide`'s
    // wait has passed the aging threshold, so it is preferred (the
    // accumulated deferral row stands in for the natural wait_since the
    // scheduler would have accumulated across the prior ticks).
    const ctx = harness(doc([agent('wide'), agent('narrow')], [
      { id: 'w-end', from: 'wide', on: 'complete', to: 'END' },
      { id: 'n-end', from: 'narrow', on: 'complete', to: 'END' },
    ], ['wide', 'narrow']));
    const t0 = '2026-08-12T00:00:00.000Z';
    const now = '2026-08-12T00:01:30.000Z'; // 90s past the wide node's first deferral
    entryFor(ctx, 'entry-narrow', 'narrow', t0);
    entryFor(ctx, 'entry-wide', 'wide', '2026-08-12T00:00:05.000Z');
    ctx.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, 'wide', 'parallel-slot-busy: active process ceiling reached', '2026-08-12T00:00:00.000Z', ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, t0);
    const result = runCoordinatorTick(ctx.makeDeps({
      maxParallelOf: () => 1,
      now: () => now,
      domainsForActivation: () => [],
    }), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(1);
    // The AGED wide node won the single slot, not the older-created narrow one.
    expect(runIdForNode(ctx.db, ctx.revisionId, 'wide')).toBeDefined();
    expect(runIdForNode(ctx.db, ctx.revisionId, 'narrow')).toBeUndefined();
    const deferral = deferralRow(ctx.db, 'narrow');
    expect(deferral?.reason).toMatch(/parallel-slot-busy/);
  });
});

describe('activeGraphRunIds (G1a — project scope)', () => {
  it('only returns running runs whose ticket belongs to the scoped project', () => {
    const { db } = openStore(':memory:');
    db.prepare("INSERT INTO tickets (id, key, project_id) VALUES (1, 'A-1', 1)").run();
    db.prepare("INSERT INTO tickets (id, key, project_id) VALUES (2, 'B-1', 2)").run();
    const insertRun = (id: number, ticketId: number, stageAttempt: number, status: string): void => {
      db.prepare(
        `INSERT INTO approach_graph_runs
           (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, ?, 'impl', ?, 'a', ?, '2026-08-12T00:00:00.000Z')`,
      ).run(id, ticketId, stageAttempt, status);
    };
    insertRun(1, 1, 1, 'running'); // project 1, running — included
    insertRun(2, 2, 1, 'running'); // project 2, running — excluded (other project)
    insertRun(3, 1, 2, 'blocked'); // project 1, not running — excluded (wrong status)

    expect(activeGraphRunIds(db, { projectId: 1 })).toEqual([1]);
    expect(activeGraphRunIds(db, { projectId: 2 })).toEqual([2]);
    expect(activeGraphRunIds(db, { projectId: 3 })).toEqual([]);
  });

  it('excludes a running run whose ticket is paused, and includes it again once unpaused', () => {
    const { db } = openStore(':memory:');
    db.prepare("INSERT INTO tickets (id, key, project_id) VALUES (1, 'A-1', 1)").run();
    db.prepare("INSERT INTO tickets (id, key, project_id) VALUES (2, 'A-2', 1)").run();
    const insertRun = (id: number, ticketId: number): void => {
      db.prepare(
        `INSERT INTO approach_graph_runs
           (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, ?, 'impl', 1, 'a', 'running', '2026-08-12T00:00:00.000Z')`,
      ).run(id, ticketId);
    };
    insertRun(1, 1);
    insertRun(2, 2);

    db.prepare("UPDATE tickets SET paused_at = '2026-09-02T00:00:00.000Z' WHERE id = 1").run();
    expect(activeGraphRunIds(db, { projectId: 1 })).toEqual([2]);

    // Pause never touches the run row, so unpausing restores scheduling with
    // no recovery step of its own.
    db.prepare('UPDATE tickets SET paused_at = NULL WHERE id = 1').run();
    expect(activeGraphRunIds(db, { projectId: 1 })).toEqual([1, 2]);
  });
});

/**
 * T1333 (issue H4, second pass): the deferral ceiling depends on the HOLDER.
 * A live holder (`launching`/`running`/`completing`/`integrating`) keeps a
 * bounded 4-hour ceiling, because an agent node that runs 40 minutes is making
 * progress; a parked, dead, ambiguous or missing holder — and a parallel slot
 * with no live node behind it — keeps 30 minutes. `wait_since` never moves, so
 * a holder that leaves the live set after the waiter's 30th minute times out on
 * the very next tick.
 */
describe('H4 live-holder deferral ceiling (T1333)', () => {
  const T0 = '2026-08-12T00:00:00.000Z';
  const MIN = 60_000;
  const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * MIN).toISOString();
  const DOM = { physicalDomain: 'dom-api', accessMode: 'write' as const, paths: [] as string[] };

  interface Domain {
    physicalDomain: string;
    accessMode: 'read' | 'write';
    paths?: readonly string[];
  }

  const oneNode = (): Ctx =>
    harness(doc([agent('a')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['a']));

  const twoNodes = (): Ctx =>
    harness(doc([agent('a'), agent('b')], [
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ], ['a', 'b']));

  function entry(ctx: Ctx, nodeId: string): number {
    return insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: `entry-${nodeId}`, destinationNodeId: nodeId, destinationEnd: false },
    ], T0)[0]!;
  }

  function seedDeferral(ctx: Ctx, nodeId: string, since: string): void {
    ctx.db
      .prepare(
        `INSERT INTO approach_node_deferrals (graph_run_id, revision_id, node_id, reason, wait_since, updated_at)
         VALUES (?, ?, ?, 'resource-conflict: seeded', ?, ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, nodeId, since, since);
  }

  function deferralOf(
    ctx: Ctx,
    nodeId: string,
  ): { reason: string; wait_since: string } | undefined {
    return ctx.db
      .prepare('SELECT reason, wait_since FROM approach_node_deferrals WHERE node_id = ?')
      .get(nodeId) as { reason: string; wait_since: string } | undefined;
  }

  function runOf(ctx: Ctx): { status: string; blocked_reason: string | null } {
    return ctx.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string; blocked_reason: string | null };
  }

  function hold(ctx: Ctx, ownerNodeRunId: number, domain = 'dom-api'): number {
    return acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId,
      physicalDomain: domain,
      accessMode: 'write',
      claimedPaths: null,
      now: T0,
    });
  }

  function setActiveProcesses(ctx: Ctx, count: number): void {
    ctx.db
      .prepare('UPDATE approach_graph_runs SET active_processes = ? WHERE id = ?')
      .run(count, ctx.graphRunId);
  }

  function tick(
    ctx: Ctx,
    now: string,
    overrides: Partial<SweepDeps> = {},
    domains: readonly Domain[] = [DOM],
  ): ReturnType<typeof runCoordinatorTick> {
    return runCoordinatorTick(
      ctx.makeDeps({
        now: () => now,
        domainsForActivation: () => [...domains],
        ...overrides,
      }),
      { graphRunId: ctx.graphRunId },
    );
  }

  it('documents two ceilings: 30 minutes by default, 4 hours for a live holder', () => {
    expect(MAX_DEFERRAL_WAIT_MS).toBe(30 * MIN);
    expect(MAX_LIVE_HOLDER_WAIT_MS).toBe(4 * 60 * MIN);
  });

  it('a node that waits 31 min on a live owner is deferred — the run stays running and wait_since never moves', () => {
    const ctx = oneNode();
    hold(ctx, liveOwnerInRun(ctx));
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);

    const result = tick(ctx, T0);

    expect(result.claimed).toBe(0);
    expect(runOf(ctx).status).toBe('running');
    const row = deferralOf(ctx, 'a')!;
    expect(row.reason).toMatch(/^resource-conflict/);
    expect(row.wait_since).toBe(since);
  });

  it('a node that reaches the 4 h live ceiling is parked graph-deferral-timeout', () => {
    const ctx = oneNode();
    hold(ctx, liveOwnerInRun(ctx));
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-(MAX_LIVE_HOLDER_WAIT_MS / MIN)));

    tick(ctx, T0);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('a parked owner at 31 min keeps the 30-minute ceiling', () => {
    const ctx = oneNode();
    hold(ctx, parkedOwner(ctx, 'blocked'));
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));

    tick(ctx, T0);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('a stale owner at 31 min keeps the 30-minute ceiling', () => {
    const ctx = oneNode();
    hold(ctx, parkedOwner(ctx, 'stale'));
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));

    tick(ctx, T0);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('an ambiguous-process lease timed out at 31 min even when its owner row is running', () => {
    const ctx = oneNode();
    const owner = liveOwnerInRun(ctx);
    hold(ctx, owner);
    expect(markLeaseAmbiguous(ctx.db, owner)).toBe(1);
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));

    tick(ctx, T0);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('one live and one parked lease on the same domain time out at 31 min — every conflicting lease is inspected', () => {
    const ctx = oneNode();
    hold(ctx, liveOwnerInRun(ctx));
    hold(ctx, parkedOwner(ctx, 'blocked'));
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));

    tick(ctx, T0);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('parallel-slot-busy at 31 min with a live node keeps waiting, and times out at the 4 h ceiling', () => {
    const ctx = oneNode();
    liveOwnerInRun(ctx);
    setActiveProcesses(ctx, 1);
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);

    tick(ctx, T0, { maxParallelOf: () => 1 }, []);

    expect(runOf(ctx).status).toBe('running');
    const row = deferralOf(ctx, 'a')!;
    expect(row.reason).toMatch(/^parallel-slot-busy/);
    expect(row.wait_since).toBe(since);

    const atCeiling = new Date(Date.parse(since) + MAX_LIVE_HOLDER_WAIT_MS).toISOString();
    tick(ctx, atCeiling, { maxParallelOf: () => 1 }, []);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('parallel-slot-busy at 31 min with no live node in this run times out — another run\'s live node does not count', () => {
    const ctx = oneNode();
    parkedOwner(ctx, 'running'); // live, but in a DIFFERENT graph run
    setActiveProcesses(ctx, 1);
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));

    tick(ctx, T0, { maxParallelOf: () => 1 }, []);

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('parallel-slot-busy at 31 min when an agent was claimed earlier in the same tick keeps waiting', () => {
    const ctx = twoNodes();
    entry(ctx, 'a');
    entry(ctx, 'b');
    const since = at(-31);
    // Both wait equally, so aging leaves the creation order alone: `a` takes
    // the single slot and `b` meets the ceiling in the same tick.
    seedDeferral(ctx, 'a', since);
    seedDeferral(ctx, 'b', since);

    const result = tick(ctx, T0, { maxParallelOf: () => 1 }, []);

    expect(result.claimed).toBe(1);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'a')).toBeDefined();
    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'b')!.wait_since).toBe(since);
  });

  it('a conflict with a peer already claimed in the same tick keeps waiting at 31 min', () => {
    const ctx = twoNodes();
    entry(ctx, 'a');
    entry(ctx, 'b');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);
    seedDeferral(ctx, 'b', since);

    const result = tick(ctx, T0);

    expect(result.claimed).toBe(1);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'a')).toBeDefined();
    expect(runOf(ctx).status).toBe('running');
    const row = deferralOf(ctx, 'b')!;
    expect(row.reason).toMatch(/^resource-conflict/);
    expect(row.wait_since).toBe(since);
  });

  it('a command node executing in place at `ready` is a live holder — 31 min keeps waiting', () => {
    const ctx = oneNode();
    const owner = insertNodeRunRow(ctx.db, {
      graphRunId: ctx.graphRunId,
      revisionId: ctx.revisionId,
      nodeId: 'foreign-owner',
      nodeKind: 'command',
      status: 'ready',
    });
    hold(ctx, owner);
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);

    tick(ctx, T0);

    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'a')!.wait_since).toBe(since);
  });

  it('a freshly claimed agent at `ready` is a live holder — 31 min keeps waiting', () => {
    const ctx = oneNode();
    hold(ctx, liveOwnerInRun(ctx, 'ready'));
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);

    tick(ctx, T0);

    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'a')!.wait_since).toBe(since);
  });

  it('parallel-slot-busy at 31 min with a freshly claimed agent at `ready` keeps waiting', () => {
    const ctx = oneNode();
    insertNodeRunRow(ctx.db, {
      graphRunId: ctx.graphRunId,
      revisionId: ctx.revisionId,
      nodeId: 'foreign-owner',
      status: 'ready',
    });
    setActiveProcesses(ctx, 1);
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);

    tick(ctx, T0, { maxParallelOf: () => 1 }, []);

    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'a')!.wait_since).toBe(since);
  });

  it('a gate claimed earlier in the tick consumes no process slot — a later agent still claims', () => {
    const ctx = harness(doc([gate('g'), agent('a')], [
      { id: 'g-end', from: 'g', on: 'matched', to: 'END' },
      { id: 'a-end', from: 'a', on: 'complete', to: 'END' },
    ], ['g', 'a']));
    // 'g' is token 1, so the tick claims the gate before the agent.
    entry(ctx, 'g');
    entry(ctx, 'a');

    const result = tick(ctx, T0, { maxParallelOf: () => 1 }, []);

    expect(result.claimed).toBe(2);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'a')).toBeDefined();
    expect(deferralOf(ctx, 'a')).toBeUndefined();
  });

  it('a claim that races a live lease holder re-reads liveness — 31 min keeps the 4 h ceiling', () => {
    const ctx = oneNode();
    const owner = liveOwnerInRun(ctx);
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);
    let raced = false;

    tick(ctx, T0, {
      domainsForActivation: () => {
        // Land the lease AFTER the tick's lease snapshot: the scheduler admits
        // the group and the claim's lease backstop throws GraphClaimError.
        if (!raced) {
          raced = true;
          hold(ctx, owner);
        }
        return [DOM];
      },
    });

    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'a')!.wait_since).toBe(since);
  });

  it('a claim that races a parked lease holder keeps the 30-minute ceiling', () => {
    const ctx = oneNode();
    const owner = parkedOwner(ctx, 'blocked');
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));
    let raced = false;

    tick(ctx, T0, {
      domainsForActivation: () => {
        if (!raced) {
          raced = true;
          hold(ctx, owner);
        }
        return [DOM];
      },
    });

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('a claim that races the process ceiling with a live node keeps waiting at 31 min', () => {
    const ctx = oneNode();
    entry(ctx, 'a');
    const since = at(-31);
    seedDeferral(ctx, 'a', since);
    let raced = false;

    tick(ctx, T0, {
      maxParallelOf: () => 1,
      domainsForActivation: () => {
        if (!raced) {
          raced = true;
          setActiveProcesses(ctx, 1);
          liveOwnerInRun(ctx);
        }
        return [];
      },
    });

    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'a')!.wait_since).toBe(since);
  });

  it('a claim that races the process ceiling with no live node times out at 31 min', () => {
    const ctx = oneNode();
    entry(ctx, 'a');
    seedDeferral(ctx, 'a', at(-31));
    let raced = false;

    tick(ctx, T0, {
      maxParallelOf: () => 1,
      domainsForActivation: () => {
        if (!raced) {
          raced = true;
          setActiveProcesses(ctx, 1);
        }
        return [];
      },
    });

    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });

  it('a holder that leaves the live set after 30 min times out on the very next tick', () => {
    const ctx = oneNode();
    const owner = parkedOwner(ctx, 'running');
    hold(ctx, owner);
    entry(ctx, 'a');
    const since = at(-35);
    seedDeferral(ctx, 'a', since);

    tick(ctx, T0);
    expect(runOf(ctx).status).toBe('running');
    expect(deferralOf(ctx, 'a')!.wait_since).toBe(since);

    ctx.db.prepare("UPDATE approach_node_runs SET status = 'stale' WHERE id = ?").run(owner);

    tick(ctx, T0);
    const run = runOf(ctx);
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toMatch(/^graph-deferral-timeout/);
  });
});
