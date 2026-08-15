/**
 * Completion + END-quiescence tests (Slice 3 Task 9).
 *
 * `completeActivation` consumes a node run's claimed tokens and inserts the
 * successor tokens for its effective outcome (END when the edge lands on
 * END; a self-loop mints the next fork instance). `flipOnEndQuiescence` is
 * the ONE-transaction END rule: at least one END token exists, no
 * pending/claimed non-END token, no non-terminal node run, no held
 * ambiguous-process lease — then `running → completed-awaiting-impl-marker`.
 * A read-then-write would let a concurrent window's successors slip between;
 * the flip re-reads every condition inside its own transaction.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import {
  completeActivation,
  flipOnEndQuiescence,
  type CompletionDeps,
  type QuiescenceDeps,
} from './completion.js';
import { insertEntryTokens } from '../../../store/graph/tokens.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
}

const GRAPH = {
  version: 1,
  title: 't',
  rationaleArtifact: 'r',
  entries: ['a'],
  artifacts: [],
  nodes: [
    {
      id: 'a',
      kind: 'agent',
      label: 'a',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: [],
      resources: { reads: [], writes: [] },
      outcomes: ['complete', 'blocked'],
      budget: { maxVisits: 1 },
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
      budget: { maxVisits: 1 },
    },
  ],
  edges: [
    { id: 'e-a-end', from: 'a', on: 'complete', to: 'END' },
    { id: 'e-b-end', from: 'b', on: 'complete', to: 'END' },
  ],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 1 },
};

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
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
      .run(graphRunId, JSON.stringify(GRAPH))
      .lastInsertRowid,
  );
  return { db, graphRunId, revisionId, ticketId };
}

function nodeRun(ctx: Ctx, id: number, nodeId: string, status = 'completed'): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', 1, ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, nodeId, status);
}

function claimEntry(ctx: Ctx, nodeRunId: number, edgeId: string): number {
  const tokenId = Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, ?, 'a', 0, 0, 'root', 'claimed', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ctx.revisionId, edgeId)
      .lastInsertRowid,
  );
  ctx.db
    .prepare('UPDATE approach_graph_tokens SET claiming_node_run_id = ? WHERE id = ?')
    .run(nodeRunId, tokenId);
  return tokenId;
}

/** A claimed token bound FOR node `b` (used where a second node is needed). */
function claimEntryForB(ctx: Ctx, nodeRunId: number, edgeId: string): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_graph_tokens
         (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
          destination_end, fork_instance, fork_lineage, status, created_at)
       VALUES (?, NULL, 1, ?, 'b', 0, 0, 'root', 'claimed', '2026-08-12T00:00:00.000Z')`,
    )
    .run(ctx.revisionId, edgeId);
}

function makeDeps(ctx: Ctx): CompletionDeps & QuiescenceDeps {
  return {
    db: ctx.db,
    transaction: <T>(fn: () => T): T =>
      (ctx.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
        begin: 'immediate',
      })(),
    now: () => '2026-08-12T00:00:00.000Z',
  };
}

function tokenStatuses(ctx: Ctx): { edge_id: string; status: string; destination_end: number }[] {
  return ctx.db
    .prepare(
      'SELECT edge_id, status, destination_end FROM approach_graph_tokens ORDER BY id',
    )
    .all() as never;
}

describe('completeActivation', () => {
  it('consumes the claimed token and inserts the outcome successor (END edge → END token)', () => {
    const ctx = harness();
    nodeRun(ctx, 11, 'a');
    const tokenId = claimEntry(ctx, 11, 'e-a-end');
    const result = completeActivation(makeDeps(ctx), {
      nodeRunId: 11,
      effectiveOutcome: 'complete',
    });
    expect(result).toEqual({ consumed: 1, inserted: 1 });
    const tokens = tokenStatuses(ctx);
    expect(tokens).toEqual([
      { edge_id: 'e-a-end', status: 'consumed', destination_end: 0 },
      { edge_id: 'e-a-end', status: 'pending', destination_end: 1 },
    ]);
    expect(tokenId).toBeGreaterThan(0);
  });

  it('a non-matching outcome inserts nothing for that node', () => {
    const ctx = harness();
    nodeRun(ctx, 12, 'a');
    claimEntry(ctx, 12, 'e-a-end');
    const result = completeActivation(makeDeps(ctx), {
      nodeRunId: 12,
      effectiveOutcome: 'blocked',
    });
    expect(result).toEqual({ consumed: 1, inserted: 0 });
  });

  it('a duplicate completion is a no-op, never a double successor', () => {
    const ctx = harness();
    nodeRun(ctx, 13, 'a');
    claimEntry(ctx, 13, 'e-a-end');
    completeActivation(makeDeps(ctx), { nodeRunId: 13, effectiveOutcome: 'complete' });
    const again = completeActivation(makeDeps(ctx), {
      nodeRunId: 13,
      effectiveOutcome: 'complete',
    });
    expect(again).toEqual({ consumed: 0, inserted: 0 });
    const tokens = tokenStatuses(ctx).filter((t) => t.status === 'pending');
    expect(tokens).toHaveLength(1);
  });

  it('a completion that consumed no claimed token emits no successor (a discarded run)', () => {
    // Slice 4 Task 4: a valid-but-late completion arriving after a discard has
    // no claimed token (the discard cancelled it). Consuming nothing must also
    // emit nothing — a cancelled run must never route the graph.
    const ctx = harness();
    nodeRun(ctx, 14, 'a');
    ctx.db.prepare("UPDATE approach_node_runs SET status = 'cancelled' WHERE id = 14").run();
    const result = completeActivation(makeDeps(ctx), {
      nodeRunId: 14,
      effectiveOutcome: 'complete',
    });
    expect(result).toEqual({ consumed: 0, inserted: 0 });
    const pending = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it('a draining revision consumes and records evidence but creates no successor', () => {
    // Slice 4 Task 5: once the replan election moved the revision to draining,
    // a finishing node still consumes its claimed token (evidence recorded)
    // but inserts NO successor — the drain owns the continuation and a drained
    // completion must never route the old revision.
    const ctx = harness();
    ctx.db.prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?").run(
      ctx.graphRunId,
    );
    nodeRun(ctx, 15, 'a');
    claimEntry(ctx, 15, 'e-a-end');
    const result = completeActivation(makeDeps(ctx), {
      nodeRunId: 15,
      effectiveOutcome: 'complete',
    });
    expect(result).toEqual({ consumed: 1, inserted: 0 });
    const tokens = tokenStatuses(ctx);
    expect(tokens).toEqual([{ edge_id: 'e-a-end', status: 'consumed', destination_end: 0 }]);
  });

  it('a blocked run still records a finishing node’s evidence without throwing (Slice 5 T6)', () => {
    // The first fault blocks the run while already-active nodes are still
    // finishing: the completion is NOT a claim path, so it must still consume
    // the claimed token (the completed work's evidence is never dropped by a
    // block) and route its successors — recovery reopens the run and the graph
    // continues past the finished node. Unlike `draining`, a blocked run keeps
    // its continuation; the sweep stops NEW launches, not recorded completions.
    const ctx = harness();
    ctx.db
      .prepare(
        "UPDATE approach_graph_runs SET status = 'blocked', blocked_reason = 'node-blocked: node 9 (x)' WHERE id = ?",
      )
      .run(ctx.graphRunId);
    nodeRun(ctx, 16, 'a');
    claimEntry(ctx, 16, 'e-a-end');
    const result = completeActivation(makeDeps(ctx), {
      nodeRunId: 16,
      effectiveOutcome: 'complete',
    });
    expect(result).toEqual({ consumed: 1, inserted: 1 });
    const tokens = tokenStatuses(ctx);
    expect(tokens).toEqual([
      { edge_id: 'e-a-end', status: 'consumed', destination_end: 0 },
      { edge_id: 'e-a-end', status: 'pending', destination_end: 1 },
    ]);
  });

  it('diagnoses an unparseable canonical graph after consuming its claimed token', () => {
    // A corrupted persisted graph must not silently eat a claimed token. The
    // diagnostic is emitted through the bounded graph-diagnostic seam, never
    // from raw canonical JSON or parser prose.
    const ctx = harness();
    nodeRun(ctx, 17, 'a');
    claimEntry(ctx, 17, 'e-a-end');
    ctx.db
      .prepare('UPDATE approach_graph_revisions SET canonical_graph = ? WHERE id = ?')
      .run('{not valid JSON', ctx.revisionId);
    const debug: string[] = [];

    const result = completeActivation(
      { ...makeDeps(ctx), debug: (line) => debug.push(line) },
      { nodeRunId: 17, effectiveOutcome: 'complete' },
    );

    expect(result).toEqual({ consumed: 1, inserted: 0 });
    expect(tokenStatuses(ctx)).toEqual([{ edge_id: 'e-a-end', status: 'consumed', destination_end: 0 }]);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('[graph:completion-rejection]');
    expect(debug[0]).toContain('canonical graph could not be parsed after consuming a token');
    expect(debug[0]).not.toContain('{not valid JSON');
  });

  it('diagnoses a node id absent from an otherwise parseable canonical graph', () => {
    // The sibling silence: the graph parses, but the completing run's node is
    // not in it, so no edge is walkable and the consumed token has nowhere to
    // go. Same bounded seam, distinct wording — without it this reads exactly
    // like a legitimate completion with zero successors.
    const ctx = harness();
    nodeRun(ctx, 17, 'a');
    claimEntry(ctx, 17, 'e-a-end');
    ctx.db
      .prepare('UPDATE approach_node_runs SET node_id = ? WHERE id = ?')
      .run('vanished', 17);
    const debug: string[] = [];

    const result = completeActivation(
      { ...makeDeps(ctx), debug: (line) => debug.push(line) },
      { nodeRunId: 17, effectiveOutcome: 'complete' },
    );

    expect(result).toEqual({ consumed: 1, inserted: 0 });
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('[graph:completion-rejection]');
    expect(debug[0]).toContain('node id absent from the canonical graph after consuming a token');
  });
});

describe('flipOnEndQuiescence', () => {
  function quiescent(ctx: Ctx): boolean {
    return flipOnEndQuiescence(makeDeps(ctx), { graphRunId: ctx.graphRunId }).flipped;
  }

  function endReached(ctx: Ctx): void {
    nodeRun(ctx, 21, 'a');
    claimEntry(ctx, 21, 'e-a-end');
    completeActivation(makeDeps(ctx), { nodeRunId: 21, effectiveOutcome: 'complete' });
  }

  it('flips only when an END token exists and nothing remains', () => {
    const ctx = harness();
    endReached(ctx);
    expect(quiescent(ctx)).toBe(true);
    const run = ctx.db
      .prepare('SELECT status, completed_at FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string; completed_at: string | null };
    expect(run.status).toBe('completed-awaiting-impl-marker');
    expect(run.completed_at).toBe('2026-08-12T00:00:00.000Z');
  });

  it('never flips without an END token', () => {
    const ctx = harness();
    nodeRun(ctx, 22, 'b');
    claimEntryForB(ctx, 22, 'e-b-end'); // b's claimed token
    expect(quiescent(ctx)).toBe(false);
  });

  it('a pending non-END token blocks the flip', () => {
    const ctx = harness();
    endReached(ctx);
    ctx.db
      .prepare(
        `INSERT INTO approach_graph_tokens
           (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
            destination_end, fork_instance, fork_lineage, status, created_at)
         VALUES (?, NULL, 1, 'e-b-end', 'b', 0, 0, 'root', 'pending', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ctx.revisionId);
    expect(quiescent(ctx)).toBe(false);
  });

  it('a non-terminal node run blocks the flip', () => {
    const ctx = harness();
    endReached(ctx);
    nodeRun(ctx, 23, 'b', 'running');
    expect(quiescent(ctx)).toBe(false);
  });

  it('an ambiguous-process lease blocks the flip', () => {
    const ctx = harness();
    endReached(ctx);
    nodeRun(ctx, 24, 'b', 'completed');
    ctx.db
      .prepare(
        `INSERT INTO approach_resource_leases
           (graph_run_id, owner_node_run_id, physical_domain, access_mode, status, acquired_at)
         VALUES (?, 24, 'd', 'write', 'ambiguous-process', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ctx.graphRunId);
    expect(quiescent(ctx)).toBe(false);
  });

  it('the flip is one transaction: conditions are re-read inside it', () => {
    const ctx = harness();
    endReached(ctx);
    const deps = makeDeps(ctx);
    let insideRead: string | null = null;
    const wrapped: QuiescenceDeps = {
      ...deps,
      transaction: <T>(fn: () => T): T =>
        deps.transaction(() => {
          // A token the outer caller could not have seen blocks the flip.
          ctx.db
            .prepare(
              `INSERT INTO approach_graph_tokens
                 (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
                  destination_end, fork_instance, fork_lineage, status, created_at)
               VALUES (?, NULL, 1, 'e-b-end', 'b', 0, 0, 'root', 'pending', '2026-08-12T00:00:00.000Z')`,
            )
            .run(ctx.revisionId);
          insideRead = 'inserted mid-transaction';
          return fn();
        }),
    };
    expect(flipOnEndQuiescence(wrapped, { graphRunId: ctx.graphRunId }).flipped).toBe(false);
    expect(insideRead).toBe('inserted mid-transaction');
    const run = ctx.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string };
    expect(run.status).toBe('running');
  });

  it('a non-running graph is never flipped', () => {
    const ctx = harness();
    endReached(ctx);
    ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('blocked', ctx.graphRunId);
    expect(quiescent(ctx)).toBe(false);
  });
});
