/**
 * Join node executor tests (Slice 3 Task 4).
 *
 * The join's work is nothing: the firing (all-or-nothing claim of every
 * correlated arrival plus the successor token) happened at claim time; the
 * visit created at firing completes directly — `ready → completing →
 * integrating → completed` — consuming the claimed arrivals in the same
 * transaction. The N-ary all-or-nothing firing itself is pinned by the claim
 * transaction tests; this suite pins the completion path and the launch-free
 * `ready → completing` edge.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import { insertEntryTokens } from '../../../store/graph/tokens.js';
import { claimJoinActivation } from '../coordinator/claim.js';
import { runJoinNode, type JoinRunDeps } from './join.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  makeDeps: (overrides?: Partial<JoinRunDeps>) => JoinRunDeps;
  revisionId: number;
  graphRunId: number;
  now: string;
}

function harness(): Ctx {
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
  const now = '2026-08-12T00:00:00.000Z';
  const base: JoinRunDeps = {
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
        fn,
        { begin: 'immediate' },
      )(),
    now: () => now,
  };
  return { db, makeDeps: (overrides) => ({ ...base, ...overrides }), revisionId, graphRunId, now };
}

describe('runJoinNode', () => {
  it('completes a fired join: ready → completed, consuming every claimed arrival', () => {
    const ctx = harness();
    const arrivals = insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'in-a', destinationNodeId: 'j', destinationEnd: false },
      { edgeId: 'in-b', destinationNodeId: 'j', destinationEnd: false },
    ], ctx.now);
    const fired = claimJoinActivation(ctx.makeDeps(), {
      tokenIds: arrivals,
      outgoing: {
        edgeId: 'j-out',
        destinationNodeId: 'finisher',
        destinationEnd: false,
        forkInstance: 0,
        forkLineage: 'root',
      },
    });
    expect(fired.claimed).toBe(true);
    if (!fired.claimed) return;
    const consumed = runJoinNode(ctx.makeDeps(), { nodeRunId: fired.nodeRunId, arrivalTokenIds: arrivals });
    expect(consumed).toBe(true);
    const run = ctx.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(fired.nodeRunId) as { status: string };
    expect(run.status).toBe('completed');
    const tokenStates = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE id IN (?, ?) ORDER BY id')
      .all(arrivals[0]!, arrivals[1]!) as { status: string }[];
    expect(tokenStates.map((t) => t.status)).toEqual(['consumed', 'consumed']);
    const successor = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE edge_id = ?')
      .get('j-out') as { status: string };
    expect(successor.status).toBe('pending');
  });

  it('a raced completion is a no-op: the run already moved', () => {
    const ctx = harness();
    const [arrival] = insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'in-a', destinationNodeId: 'j', destinationEnd: false },
    ], ctx.now);
    const fired = claimJoinActivation(ctx.makeDeps(), {
      tokenIds: [arrival!],
      outgoing: {
        edgeId: 'j-out',
        destinationNodeId: 'finisher',
        destinationEnd: false,
        forkInstance: 0,
        forkLineage: 'root',
      },
    });
    expect(fired.claimed).toBe(true);
    if (!fired.claimed) return;
    expect(runJoinNode(ctx.makeDeps(), { nodeRunId: fired.nodeRunId, arrivalTokenIds: [arrival!] })).toBe(true);
    expect(runJoinNode(ctx.makeDeps(), { nodeRunId: fired.nodeRunId, arrivalTokenIds: [arrival!] })).toBe(false);
    expect(ctx.db.prepare('SELECT status FROM approach_node_runs WHERE id = ?').get(fired.nodeRunId)).toMatchObject({
      status: 'completed',
    });
  });

  it('a throw rolls the completion back — nothing consumed, run still ready', () => {
    const ctx = harness();
    const [arrival] = insertEntryTokens(ctx.db, ctx.revisionId, [
      { edgeId: 'in-a', destinationNodeId: 'j', destinationEnd: false },
    ], ctx.now);
    const fired = claimJoinActivation(ctx.makeDeps(), {
      tokenIds: [arrival!],
      outgoing: {
        edgeId: 'j-out',
        destinationNodeId: 'finisher',
        destinationEnd: false,
        forkInstance: 0,
        forkLineage: 'root',
      },
    });
    if (!fired.claimed) return;
    const deps = ctx.makeDeps({
      transaction: (fn) =>
        (ctx.db.transaction as unknown as (f: () => unknown, o: { begin: 'immediate' }) => () => unknown)(
          () => {
            fn();
            throw new Error('boom');
          },
          { begin: 'immediate' },
        )() as never,
    });
    expect(() => runJoinNode(deps, { nodeRunId: fired.nodeRunId, arrivalTokenIds: [arrival!] })).toThrow(
      'boom',
    );
    expect(ctx.db.prepare('SELECT status FROM approach_node_runs WHERE id = ?').get(fired.nodeRunId)).toMatchObject({
      status: 'ready',
    });
    const token = ctx.db.prepare('SELECT status FROM approach_graph_tokens WHERE id = ?').get(arrival!) as {
      status: string;
    };
    expect(token.status).toBe('claimed');
  });
});
