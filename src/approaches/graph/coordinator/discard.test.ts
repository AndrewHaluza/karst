/**
 * Discard unknown process tests (Slice 4 Task 4).
 *
 * The named exit for the permanent-stall class: `launch-unknown` and
 * `termination-unknown` node runs are discarded in ONE `BEGIN IMMEDIATE`
 * transaction — token `claimed → cancelled`, run `cancelled`, reserved graph
 * and expert budget contributions released, leases released, then the graph
 * re-evaluated (`graph-topology-deadlock` when the discarded run was the only
 * satisfier). The transaction is conditional on current status, so a second
 * window's discard is an idempotent no-op, and a late completion after a
 * discard is an idempotent rejection.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../../../store/db.js';
import type { GraphDb } from '../../../store/graph/transitions.js';
import { acquireLease } from '../../../store/graph/leases.js';
import { workspacesForNode } from '../../../store/graph/nodeRuns.js';
import type { ProcessFacts } from '../../../runtime/serverIdentity.js';
import { cleanupNodeWorkspace } from '../workspace/cleanup.js';
import { completeActivation } from './completion.js';
import { discardUnknownProcess, type DiscardDeps } from './discard.js';

const NOW = '2026-08-12T00:00:00.000Z';

/** A chain `a → b → END`: `a` is the ONLY satisfier of `b`'s arrival. */
const GRAPH = {
  version: 1,
  title: 'discard',
  rationaleArtifact: 'r',
  entries: ['a'],
  artifacts: [],
  nodes: [
    {
      id: 'a',
      kind: 'agent',
      label: 'a',
      profile: 'expert',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked'],
      budget: { maxVisits: 2 },
    },
    {
      id: 'b',
      kind: 'agent',
      label: 'b',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete'],
      budget: { maxVisits: 2 },
    },
  ],
  edges: [
    { id: 'e-a-b', from: 'a', on: 'complete', to: 'b' },
    { id: 'e-b-end', from: 'b', on: 'complete', to: 'END' },
  ],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 2, maxReplans: 1 },
};

interface Ctx {
  store: Store;
  db: GraphDb & ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
  makeDeps: (overrides?: Partial<DiscardDeps>) => DiscardDeps;
}

function withImmediate<T>(db: ReturnType<typeof openStore>['db'], fn: () => T): T {
  const runner = (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
    fn,
    { begin: 'immediate' },
  );
  return runner();
}

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('D-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'x', 'running', ?)`,
      )
      .run(ticketId, NOW)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, ?, 'fp', 'active', ?)`,
      )
      .run(graphRunId, JSON.stringify(GRAPH), NOW)
      .lastInsertRowid,
  );
  const makeDeps = (overrides: Partial<DiscardDeps> = {}): DiscardDeps => ({
    db,
    transaction: <T>(fn: () => T): T => withImmediate(db, fn),
    now: () => NOW,
    debug: () => {},
    cleanupNodeWorkspace: () => undefined,
    ...overrides,
  });
  return { store, db, graphRunId, revisionId, ticketId, makeDeps };
}

const deadProcessFacts: ProcessFacts = {
  isAlive: () => false,
  liveCwd: () => null,
  processStartMs: () => null,
};

function nodeRun(
  ctx: Ctx,
  id: number,
  nodeId: string,
  status: string,
  extra: { visitNumber?: number } = {},
): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', ?, ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, nodeId, extra.visitNumber ?? 1, status);
}

/** A claimed token for the node visit `nodeRunId` (entry → nodeId). */
function claimToken(ctx: Ctx, nodeRunId: number, nodeId: string, edgeId: string): number {
  const tokenId = Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, ?, ?, 0, 0, 'root', 'claimed', ?)`,
      )
      .run(ctx.revisionId, edgeId, nodeId, NOW)
      .lastInsertRowid,
  );
  ctx.db
    .prepare('UPDATE approach_graph_tokens SET claiming_node_run_id = ? WHERE id = ?')
    .run(nodeRunId, tokenId);
  return tokenId;
}

function lease(ctx: Ctx, nodeRunId: number, status: 'held' | 'ambiguous-process' = 'held'): void {
  acquireLease(ctx.db, {
    graphRunId: ctx.graphRunId,
    ownerNodeRunId: nodeRunId,
    physicalDomain: `dom-${nodeRunId}`,
    accessMode: 'write',
    claimedPaths: 'x',
    now: NOW,
  });
  if (status === 'ambiguous-process') {
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE owner_node_run_id = ?")
      .run(nodeRunId);
  }
}

function graphCounters(ctx: Ctx): { node_run_count: number; expert_run_count: number } {
  return ctx.db
    .prepare('SELECT node_run_count, expert_run_count FROM approach_graph_runs WHERE id = ?')
    .get(ctx.graphRunId) as { node_run_count: number; expert_run_count: number };
}

function graphRun(ctx: Ctx): { status: string; blocked_reason: string | null } {
  return ctx.db
    .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
    .get(ctx.graphRunId) as { status: string; blocked_reason: string | null };
}

function nodeRow(ctx: Ctx, id: number): { status: string; ended_at: string | null } {
  return ctx.db
    .prepare('SELECT status, ended_at FROM approach_node_runs WHERE id = ?')
    .get(id) as { status: string; ended_at: string | null };
}

function leaseRow(ctx: Ctx, nodeRunId: number): { status: string }[] {
  return ctx.db
    .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ?')
    .all(nodeRunId) as { status: string }[];
}

describe('discardUnknownProcess', () => {
  it('cleans the terminal node workspace after a successful discard', () => {
    const ctx = harness();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'karst-node-discard-'));
    try {
      const workspaceCwd = join(workspaceRoot, 'api');
      mkdirSync(workspaceCwd);
      writeFileSync(join(workspaceCwd, 'scratch.txt'), 'discarded workspace\n');
      nodeRun(ctx, 10, 'a', 'termination-unknown');
      claimToken(ctx, 10, 'a', 'e-a-b');
      ctx.db
        .prepare(
          `INSERT INTO approach_graph_workspaces
             (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
           VALUES (?, 10, 'api', ?, 96, ?)`,
        )
        .run(ctx.graphRunId, workspaceCwd, NOW);
      ctx.db
        .prepare('UPDATE approach_graph_runs SET workspace_bytes = 96 WHERE id = ?')
        .run(ctx.graphRunId);
      const serverId = Number(
        ctx.db
          .prepare(
            `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at)
             VALUES (?, 'api', 4201, 'running', ?, ?)`,
          )
          .run(ctx.ticketId, workspaceCwd, NOW)
          .lastInsertRowid,
      );
      const deps = {
        ...ctx.makeDeps(),
        cleanupNodeWorkspace: (input: { graphRunId: number; nodeRunId: number }) =>
          cleanupNodeWorkspace(
            {
              store: ctx.store,
              transaction: <T>(fn: () => T): T => withImmediate(ctx.store.db, fn),
              facts: deadProcessFacts,
            },
            { ...input, cwd: workspaceRoot },
          ),
      } as DiscardDeps & {
        cleanupNodeWorkspace: (input: { graphRunId: number; nodeRunId: number }) => unknown;
      };

      const result = discardUnknownProcess(deps, { nodeRunId: 10 });

      expect(result.discarded).toBe(true);
      expect(existsSync(workspaceRoot)).toBe(false);
      expect(workspacesForNode(ctx.db, 10)).toEqual([]);
      expect(
        ctx.db.prepare('SELECT workspace_bytes FROM approach_graph_runs WHERE id = ?').get(ctx.graphRunId),
      ).toEqual({ workspace_bytes: 0 });
      expect(ctx.db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId)).toEqual({
        status: 'stopped',
      });
    } finally {
      ctx.store.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs the full six-step transaction: token cancelled, run cancelled, budgets and lease released, graph left running', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 2, expert_run_count = 1 WHERE id = ?')
      .run(ctx.graphRunId);
    nodeRun(ctx, 11, 'a', 'termination-unknown');
    claimToken(ctx, 11, 'a', 'e-a-b');
    lease(ctx, 11, 'ambiguous-process');
    // A parallel branch still in flight: discarding `a` must NOT deadlock it.
    nodeRun(ctx, 12, 'b', 'running');
    claimToken(ctx, 12, 'b', 'e-b-entry');

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 11 });

    expect(result).toEqual({
      discarded: true,
      cancelledTokens: 1,
      releasedLeases: 1,
      graphBlockedWith: null,
    });
    expect(nodeRow(ctx, 11).status).toBe('cancelled');
    expect(nodeRow(ctx, 11).ended_at).toBe(NOW);
    const tokens = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE claiming_node_run_id = 11')
      .all() as { status: string }[];
    expect(tokens).toEqual([{ status: 'cancelled' }]);
    expect(leaseRow(ctx, 11)).toEqual([{ status: 'released' }]);
    expect(graphCounters(ctx)).toEqual({ node_run_count: 1, expert_run_count: 0 });
    expect(graphRun(ctx)).toMatchObject({ status: 'running' });
  });

  it('keeps the cancelled verdict when terminal workspace cleanup throws', () => {
    const ctx = harness();
    nodeRun(ctx, 13, 'a', 'termination-unknown');
    claimToken(ctx, 13, 'a', 'e-a-b');

    const result = discardUnknownProcess(
      ctx.makeDeps({
        cleanupNodeWorkspace: () => {
          throw new Error('cleanup unavailable');
        },
      }),
      { nodeRunId: 13 },
    );

    expect(result.discarded).toBe(true);
    expect(nodeRow(ctx, 13).status).toBe('cancelled');
  });

  it('releases both the graph and the expert budget contributions of an expert agent run', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 5, expert_run_count = 2 WHERE id = ?')
      .run(ctx.graphRunId);
    nodeRun(ctx, 21, 'a', 'termination-unknown');
    claimToken(ctx, 21, 'a', 'e-a-b');
    nodeRun(ctx, 22, 'b', 'running'); // keeps the graph alive

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 21 });

    expect(result).toMatchObject({ discarded: true });
    expect(graphCounters(ctx)).toEqual({ node_run_count: 4, expert_run_count: 1 });
  });

  it('releases only the graph budget for a run that never reserved the expert budget', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 5, expert_run_count = 2 WHERE id = ?')
      .run(ctx.graphRunId);
    // `b` is a default-profile agent run; its claim reserved no expert budget.
    nodeRun(ctx, 31, 'b', 'termination-unknown');
    claimToken(ctx, 31, 'b', 'e-b-entry');

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 31 });

    expect(result).toMatchObject({ discarded: true });
    expect(graphCounters(ctx)).toEqual({ node_run_count: 4, expert_run_count: 2 });
  });

  it('two windows offering the discard: exactly one wins, the second is an idempotent no-op', () => {
    const ctx = harness();
    // Runs 41 ('a', expert) and 42 ('b', default) together reserved 2 node
    // runs and 1 expert run.
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 2, expert_run_count = 1 WHERE id = ?')
      .run(ctx.graphRunId);
    nodeRun(ctx, 41, 'a', 'termination-unknown');
    claimToken(ctx, 41, 'a', 'e-a-b');
    lease(ctx, 41);
    nodeRun(ctx, 42, 'b', 'running');
    claimToken(ctx, 42, 'b', 'e-b-entry');

    const first = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 41 });
    expect(first).toEqual({
      discarded: true,
      cancelledTokens: 1,
      releasedLeases: 1,
      graphBlockedWith: null,
    });
    // The second window reads the committed `cancelled` status: no-op.
    const second = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 41 });
    expect(second).toEqual({ discarded: false, reason: 'not-ambiguous' });
    // Nothing was re-mutated: the run is still cancelled, the budget counts
    // still reflect the ONE release (a double-release would read 0/0), and the
    // lease is still released.
    expect(nodeRow(ctx, 41).status).toBe('cancelled');
    expect(graphCounters(ctx)).toEqual({ node_run_count: 1, expert_run_count: 0 });
    expect(leaseRow(ctx, 41)).toEqual([{ status: 'released' }]);
  });

  it('a valid-but-late completion after a discard is an idempotent rejection', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 1, expert_run_count = 1 WHERE id = ?')
      .run(ctx.graphRunId);
    nodeRun(ctx, 51, 'a', 'termination-unknown');
    claimToken(ctx, 51, 'a', 'e-a-b');

    discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 51 });

    // The claimed token is gone (cancelled), so consumption moves nothing and
    // NO successor edge is emitted — the completion is rejected idempotently.
    const late = completeActivation(ctx.makeDeps(), { nodeRunId: 51, effectiveOutcome: 'complete' });
    expect(late).toEqual({ consumed: 0, inserted: 0 });
    const successors = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = ?')
      .get('pending') as { n: number };
    expect(successors.n).toBe(0);
  });

  it('an unsatisfiable edge yields graph-topology-deadlock, never silence', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 1, expert_run_count = 1 WHERE id = ?')
      .run(ctx.graphRunId);
    // `a` is the ONLY satisfier of `b` (e-a-b), and b is the only path to END.
    nodeRun(ctx, 61, 'a', 'termination-unknown');
    claimToken(ctx, 61, 'a', 'e-a-b');

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 61 });

    expect(result).toEqual({
      discarded: true,
      cancelledTokens: 1,
      releasedLeases: 0,
      graphBlockedWith: 'graph-topology-deadlock',
    });
    expect(graphRun(ctx)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'graph-topology-deadlock',
    });
  });

  it('keeps the graph running when other work remains after the discard', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 2, expert_run_count = 1 WHERE id = ?')
      .run(ctx.graphRunId);
    nodeRun(ctx, 71, 'a', 'termination-unknown');
    claimToken(ctx, 71, 'a', 'e-a-b');
    // A pending token for `b` remains schedulable: not a deadlock.
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, 'e-b-again', 'b', 0, 0, 'root', 'pending', ?)`,
      )
      .run(ctx.revisionId, NOW);

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 71 });

    expect(result).toEqual({
      discarded: true,
      cancelledTokens: 1,
      releasedLeases: 0,
      graphBlockedWith: null,
    });
    expect(graphRun(ctx).status).toBe('running');
  });

  it('discards a launch-unknown run the same way', () => {
    const ctx = harness();
    ctx.db
      .prepare('UPDATE approach_graph_runs SET node_run_count = 1, expert_run_count = 1 WHERE id = ?')
      .run(ctx.graphRunId);
    nodeRun(ctx, 81, 'a', 'launch-unknown');
    claimToken(ctx, 81, 'a', 'e-a-b');

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 81 });

    expect(result).toEqual({
      discarded: true,
      cancelledTokens: 1,
      releasedLeases: 0,
      graphBlockedWith: 'graph-topology-deadlock',
    });
    expect(nodeRow(ctx, 81).status).toBe('cancelled');
  });

  it('refuses a node that is not in an ambiguous status', () => {
    const ctx = harness();
    nodeRun(ctx, 91, 'a', 'running');
    claimToken(ctx, 91, 'a', 'e-a-b');

    const result = discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 91 });

    expect(result).toEqual({ discarded: false, reason: 'not-ambiguous' });
    expect(nodeRow(ctx, 91).status).toBe('running');
    const tokens = ctx.db
      .prepare('SELECT status FROM approach_graph_tokens WHERE claiming_node_run_id = 91')
      .all() as { status: string }[];
    expect(tokens).toEqual([{ status: 'claimed' }]);
  });

  it('returns not-found for an unknown node run or a foreign graph run id', () => {
    const ctx = harness();
    expect(discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 999 })).toEqual({
      discarded: false,
      reason: 'not-found',
    });
    nodeRun(ctx, 95, 'a', 'termination-unknown');
    expect(
      discardUnknownProcess(ctx.makeDeps(), { nodeRunId: 95, graphRunId: ctx.graphRunId + 1 }),
    ).toEqual({ discarded: false, reason: 'not-found' });
  });
});
