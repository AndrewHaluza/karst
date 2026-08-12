/**
 * The claim transaction (Slice 3 Task 1).
 *
 * Claiming is transactionally single-winner across windows: in one
 * `BEGIN IMMEDIATE` transaction Karst conditionally changes a token from
 * `pending` to `claimed`, creates its node-run visit, reserves graph/node/
 * expert budgets, and stores the claiming run. Scheduling continues only when
 * exactly the expected number of rows changed — 1 for a single activation,
 * `|waitFor|` for a join firing, which is all-or-nothing. External launch
 * happens after commit, never inside the transaction. A contended
 * `BEGIN IMMEDIATE` in the extension host aborts immediately (busy timeout 0),
 * mutates nothing, and is retried next tick.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../store/db.js';
import { insertEntryTokens, insertGraphToken, claimGraphToken } from '../../../store/graph/tokens.js';
import {
  claimActivation,
  claimJoinActivation,
  incrementLaunchAttempt,
  claimedNodeRunForToken,
  type ClaimDeps,
} from './claim.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  makeDeps: (overrides?: Partial<ClaimDeps>) => ClaimDeps;
  graphRunId: number;
  revisionId: number;
  now: string;
}

function setup(db: ReturnType<typeof openStore>['db']): { graphRunId: number; revisionId: number } {
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
  return { graphRunId, revisionId };
}

/** BEGIN IMMEDIATE wrapper: the installed @types predate the `{begin}` option
 *  (runtime better-sqlite3 12.x supports it), so the option is cast once. */
function withImmediate<T>(db: ReturnType<typeof openStore>['db'], fn: () => T): T {
  const runner = (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
    fn,
    { begin: 'immediate' },
  );
  return runner();
}

function harness(path: string = ':memory:'): Ctx {
  const store = openStore(path);
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const { graphRunId, revisionId } = setup(db);
  const now = '2026-08-12T00:00:00.000Z';
  const base: ClaimDeps = {
    db,
    transaction: <T>(fn: () => T): T => withImmediate(db, fn),
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

function entryTokenId(ctx: Ctx, edgeId = 'entry-a'): number {
  const ids = insertEntryTokens(ctx.db, ctx.revisionId, [
    { edgeId, destinationNodeId: 'worker-a', destinationEnd: false },
  ], ctx.now);
  return ids[0]!;
}

function runCount(db: Ctx['db'], revisionId: number): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM approach_node_runs WHERE revision_id = ?')
      .get(revisionId) as { n: number }
  ).n;
}

function graphCounters(db: Ctx['db'], graphRunId: number): { node: number; expert: number } {
  const row = db
    .prepare('SELECT node_run_count, expert_run_count FROM approach_graph_runs WHERE id = ?')
    .get(graphRunId) as { node_run_count: number; expert_run_count: number };
  return { node: row.node_run_count, expert: row.expert_run_count };
}

describe('claimActivation', () => {
  it('claims the token, creates the node-run visit, reserves budgets, and stores the claiming run', () => {
    const ctx = harness();
    const tokenId = entryTokenId(ctx);
    const result = claimActivation(ctx.makeDeps(), { tokenId, nodeKind: 'agent', profileIsExpert: true });
    expect(result).toMatchObject({ claimed: true, visitNumber: 1 });
    if (!result.claimed) return;
    expect(runCount(ctx.db, ctx.revisionId)).toBe(1);
    const run = ctx.db
      .prepare('SELECT * FROM approach_node_runs WHERE id = ?')
      .get(result.nodeRunId) as {
      node_kind: string;
      node_id: string;
      visit_number: number;
      status: string;
      graph_run_id: number;
    };
    expect(run).toMatchObject({
      node_kind: 'agent',
      node_id: 'worker-a',
      visit_number: 1,
      status: 'ready',
      graph_run_id: ctx.graphRunId,
    });
    const token = ctx.db
      .prepare('SELECT status, claiming_node_run_id FROM approach_graph_tokens WHERE id = ?')
      .get(tokenId) as { status: string; claiming_node_run_id: number };
    expect(token).toMatchObject({ status: 'claimed', claiming_node_run_id: result.nodeRunId });
    expect(graphCounters(ctx.db, ctx.graphRunId)).toEqual({ node: 1, expert: 1 });
  });

  it('does not spend the expert budget for a worker-profile node', () => {
    const ctx = harness();
    claimActivation(ctx.makeDeps(), { tokenId: entryTokenId(ctx), nodeKind: 'agent' });
    expect(graphCounters(ctx.db, ctx.graphRunId)).toEqual({ node: 1, expert: 0 });
  });

  it('two windows claiming one token produce exactly one winner and one no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claim-race-'));
    const file = join(dir, 'shared.db');
    try {
      const ctxA = harness(file);
      const ctxB = harness(file);
      const tokenId = entryTokenId(ctxA);
      const winner = claimActivation(ctxA.makeDeps(), { tokenId, nodeKind: 'agent' });
      const loser = claimActivation(ctxB.makeDeps(), { tokenId, nodeKind: 'agent' });
      expect(winner.claimed).toBe(true);
      expect(loser).toMatchObject({ claimed: false, reason: 'not-pending' });
      expect(runCount(ctxA.db, ctxA.revisionId)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op for an unknown token', () => {
    const ctx = harness();
    expect(claimActivation(ctx.makeDeps(), { tokenId: 999, nodeKind: 'agent' })).toMatchObject({
      claimed: false,
      reason: 'not-found',
    });
  });

  it('distinct activations of the same node create distinct visits', () => {
    const ctx = harness();
    const a = insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: 7,
      isEntry: false,
      edgeId: 'fa',
      destinationNodeId: 'worker-a',
      destinationEnd: false,
      forkInstance: 0,
      forkLineage: 'root',
      now: ctx.now,
    })!;
    const b = insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: 7,
      isEntry: false,
      edgeId: 'fb',
      destinationNodeId: 'worker-a',
      destinationEnd: false,
      forkInstance: 1,
      forkLineage: 'root',
      now: ctx.now,
    })!;
    const first = claimActivation(ctx.makeDeps(), { tokenId: a, nodeKind: 'agent' });
    const second = claimActivation(ctx.makeDeps(), { tokenId: b, nodeKind: 'agent' });
    expect(first).toMatchObject({ claimed: true, visitNumber: 1 });
    expect(second).toMatchObject({ claimed: true, visitNumber: 2 });
    expect(runCount(ctx.db, ctx.revisionId)).toBe(2);
    expect(graphCounters(ctx.db, ctx.graphRunId).node).toBe(2);
  });

  it('a launch retry reuses the reserved run and creates no second visit', () => {
    const ctx = harness();
    const tokenId = entryTokenId(ctx);
    const first = claimActivation(ctx.makeDeps(), { tokenId, nodeKind: 'agent' });
    if (!first.claimed) throw new Error('expected claim');
    expect(incrementLaunchAttempt(ctx.db, first.nodeRunId)).toBe(true);
    const run = ctx.db
      .prepare('SELECT launch_attempt FROM approach_node_runs WHERE id = ?')
      .get(first.nodeRunId) as { launch_attempt: number };
    expect(run.launch_attempt).toBe(1);
    expect(claimedNodeRunForToken(ctx.db, tokenId)!.id).toBe(first.nodeRunId);
    expect(claimActivation(ctx.makeDeps(), { tokenId, nodeKind: 'agent' })).toMatchObject({
      claimed: false,
      reason: 'not-pending',
    });
    expect(runCount(ctx.db, ctx.revisionId)).toBe(1);
  });

  it('a throw inside the transaction rolls back the claim, token and budgets', () => {
    const ctx = harness();
    const tokenId = entryTokenId(ctx);
    const deps = ctx.makeDeps({
      transaction: (fn) =>
        withImmediate(ctx.db, () => {
          const inner = fn();
          throw new Error('boom after claim');
        }),
    });
    expect(() => claimActivation(deps, { tokenId, nodeKind: 'agent' })).toThrow('boom after claim');
    expect(runCount(ctx.db, ctx.revisionId)).toBe(0);
    const token = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE id = ?')
      .get(tokenId) as { status: string };
    expect(token.status).toBe('pending');
    expect(graphCounters(ctx.db, ctx.graphRunId)).toEqual({ node: 0, expert: 0 });
  });
});

describe('claimJoinActivation', () => {
  const OUTGOING = {
    edgeId: 'join-out',
    destinationNodeId: 'finisher',
    destinationEnd: false,
    forkInstance: 0,
    forkLineage: 'root',
  };

  function twoArrivals(ctx: Ctx): number[] {
    return insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'in-a', destinationNodeId: 'join', destinationEnd: false },
      { edgeId: 'in-b', destinationNodeId: 'join', destinationEnd: false },
    ], ctx.now);
  }

  it('claims all |waitFor| arrivals, creates the join visit, and inserts the successor token', () => {
    const ctx = harness();
    const arrivals = twoArrivals(ctx);
    const result = claimJoinActivation(ctx.makeDeps(), { tokenIds: arrivals, outgoing: OUTGOING });
    expect(result).toMatchObject({ claimed: true, visitNumber: 1 });
    if (!result.claimed) return;
    const statuses = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE id IN (?, ?) ORDER BY id')
      .all(arrivals[0]!, arrivals[1]!) as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(['claimed', 'claimed']);
    const joinRun = ctx.db
      .prepare('SELECT node_kind, node_id, visit_number FROM approach_node_runs WHERE id = ?')
      .get(result.nodeRunId) as { node_kind: string; node_id: string; visit_number: number };
    expect(joinRun).toMatchObject({ node_kind: 'join', node_id: 'join', visit_number: 1 });
    const successor = ctx.db
      .prepare('SELECT source_node_run_id, destination_node_id, status FROM approach_graph_tokens WHERE edge_id = ?')
      .get('join-out') as { source_node_run_id: number; destination_node_id: string; status: string };
    expect(successor).toMatchObject({
      source_node_run_id: result.nodeRunId,
      destination_node_id: 'finisher',
      status: 'pending',
    });
    expect(graphCounters(ctx.db, ctx.graphRunId).node).toBe(1);
  });

  it('the affected-row check refuses a partial claim and rolls back', () => {
    const ctx = harness();
    const arrivals = twoArrivals(ctx);
    claimGraphToken(ctx.db, arrivals[0]!, 99);
    expect(() =>
      claimJoinActivation(ctx.makeDeps(), { tokenIds: arrivals, outgoing: OUTGOING }),
    ).toThrow(/partial claim/);
    const survivor = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE id = ?')
      .get(arrivals[1]!) as { status: string };
    expect(survivor.status).toBe('pending');
    expect(runCount(ctx.db, ctx.revisionId)).toBe(0);
    const successor = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE edge_id = ?')
      .get('join-out') as { n: number };
    expect(successor.n).toBe(0);
    expect(graphCounters(ctx.db, ctx.graphRunId).node).toBe(0);
  });
});

describe('lock liveness', () => {
  it('a busied claim aborts immediately, mutates nothing, and succeeds next tick', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-claim-busy-'));
    const file = join(dir, 'busy.db');
    try {
      const holder = openStore(file);
      const ctx = harness(file);
      const tokenId = entryTokenId(ctx);
      holder.db.exec('BEGIN IMMEDIATE');
      holder.db.prepare("INSERT INTO tickets (key) VALUES ('locker')").run();
      const started = Date.now();
      expect(() => claimActivation(ctx.makeDeps(), { tokenId, nodeKind: 'agent' })).toThrow(
        'database is locked',
      );
      expect(Date.now() - started).toBeLessThan(500);
      expect(runCount(ctx.db, ctx.revisionId)).toBe(0);
      holder.db.exec('ROLLBACK');
      const retry = claimActivation(ctx.makeDeps(), { tokenId, nodeKind: 'agent' });
      expect(retry.claimed).toBe(true);
      holder.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
