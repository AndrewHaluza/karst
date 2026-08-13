/**
 * Fork lineage and join correlation (Slice 5 Task 4).
 *
 * `fork_instance_id` is a host-generated UUIDv7 minted at each fork
 * execution. The INTEGER `fork_instance` is the fork's monotonic visit
 * number; `fork_lineage` is the bounded fork-lineage STACK, outermost first.
 * Join correlation matches on the FULL stack AND the visit number, so two
 * loop iterations of one fork — or two forks that share a visit number —
 * never cross-correlate. A join firing stays one all-or-nothing transaction,
 * proven here under genuine parallel arrivals from two windows.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../store/db.js';
import {
  insertEntryTokens,
  insertGraphToken,
  pendingTokensForRevision,
} from '../../../store/graph/tokens.js';
import { MAX_FORK_LINEAGE_DEPTH } from '../../../store/graph/tokens.js';
import { GRAPH_LIMITS } from '../parse.js';
import { runCoordinatorTick, type SweepDeps } from './sweep.js';
import { claimJoinActivation, GraphClaimError } from './claim.js';
import { completeActivation, type CompletionDeps } from './completion.js';
import { uuidv7, lineageDepth, joinCorrelationKey } from './lineage.js';
import type { GraphDocument, ApproachEdge, ApproachNode } from '../parse.js';

describe('uuidv7 (lineage.ts)', () => {
  it('renders the UUIDv7 shape: 8-4-4-4-12, version 7, variant 10', () => {
    const id = uuidv7(new Date('2026-08-12T00:00:00.000Z'));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is time-ordered: an earlier clock yields a lexically smaller id', () => {
    const early = uuidv7(new Date('2026-08-12T00:00:00.000Z'));
    const late = uuidv7(new Date('2026-08-12T00:00:01.000Z'));
    expect(early < late).toBe(true);
  });

  it('carries the 48-bit unix-ms timestamp as its prefix', () => {
    const at = new Date('2026-08-12T00:00:00.000Z');
    const id = uuidv7(at);
    const hex = id.replace(/-/g, '');
    const ms = BigInt(at.getTime());
    const prefix = Number.parseInt(hex.slice(0, 12), 16);
    expect(BigInt(prefix)).toBe(ms);
  });
});

describe('fork-lineage helpers (lineage.ts)', () => {
  it('counts stack depth with the root as the outermost segment', () => {
    expect(lineageDepth(null)).toBe(0);
    expect(lineageDepth('root')).toBe(1);
    expect(lineageDepth('root:a')).toBe(2);
    expect(lineageDepth('root:a:b')).toBe(3);
  });

  it('correlates on the full stack AND the fork visit number', () => {
    // Same destination, same lineage, different visit → distinct groups.
    expect(joinCorrelationKey('j', 'root:f', 1)).not.toBe(joinCorrelationKey('j', 'root:f', 2));
    // Same destination, same visit, different lineage → distinct groups.
    expect(joinCorrelationKey('j', 'root:x', 1)).not.toBe(joinCorrelationKey('j', 'root:y', 1));
    // Same destination, lineage and visit → the SAME group.
    expect(joinCorrelationKey('j', 'root:f', 1)).toBe(joinCorrelationKey('j', 'root:f', 1));
    // A null lineage reads as the root stack, not a different group.
    expect(joinCorrelationKey('j', null, 0)).toBe(joinCorrelationKey('j', 'root', 0));
  });

  it('the store depth mirror equals the compiler nesting bound', () => {
    expect(MAX_FORK_LINEAGE_DEPTH).toBe(GRAPH_LIMITS.maxLineageDepth);
  });
});

/** The sweep harness (mirrors sweep.test.ts). */
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

function joinNode(id: string, waitFor: string[]): ApproachNode {
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

function harness(documentText: string): Ctx {
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

/** A two-branch join after a fork: f → b1,b2 → j → b → END. */
function forkJoinDoc(): string {
  return doc(
    [agent('f'), agent('b1'), agent('b2'), joinNode('j', ['b1', 'b2']), agent('b')],
    [
      { id: 'f-b1', from: 'f', on: 'complete', to: 'b1' },
      { id: 'f-b2', from: 'f', on: 'complete', to: 'b2' },
      { id: 'b1-j', from: 'b1', on: 'complete', to: 'j' },
      { id: 'b2-j', from: 'b2', on: 'complete', to: 'j' },
      { id: 'j-b', from: 'j', on: 'complete', to: 'b' },
      { id: 'b-end', from: 'b', on: 'complete', to: 'END' },
    ],
    ['f'],
  );
}

describe('join correlation under the sweep (Slice 5 T4)', () => {
  it('two loop iterations of one fork produce two independent join firings', () => {
    const ctx = harness(forkJoinDoc());
    // Two loop iterations share the lineage stack 'root:f' (the loop appends
    // no NEW segment between visits here) and differ ONLY by the fork visit
    // number — the correlation must keep the iterations apart.
    for (const fk of [1, 2]) {
      insertGraphToken(ctx.db, {
        revisionId: ctx.revisionId,
        sourceNodeRunId: 100 + fk,
        isEntry: false,
        edgeId: 'b1-j',
        destinationNodeId: 'j',
        destinationEnd: false,
        forkInstance: fk,
        forkLineage: 'root:f',
        now: ctx.now,
      });
      insertGraphToken(ctx.db, {
        revisionId: ctx.revisionId,
        sourceNodeRunId: 200 + fk,
        isEntry: false,
        edgeId: 'b2-j',
        destinationNodeId: 'j',
        destinationEnd: false,
        forkInstance: fk,
        forkLineage: 'root:f',
        now: ctx.now,
      });
    }
    const result = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(2);
    // Exactly two join firings, one per loop iteration.
    const joinRuns = ctx.db
      .prepare("SELECT visit_number FROM approach_node_runs WHERE node_id = 'j' ORDER BY visit_number")
      .all() as { visit_number: number }[];
    expect(joinRuns.map((r) => r.visit_number)).toEqual([1, 2]);
    // Each firing correlated ITS OWN pair: two successors with the shared
    // lineage, one per visit number.
    const successors = ctx.db
      .prepare(
        "SELECT fork_instance, fork_lineage FROM approach_graph_tokens WHERE edge_id = 'j-b' ORDER BY fork_instance",
      )
      .all() as { fork_instance: number; fork_lineage: string }[];
    expect(successors).toEqual([
      { fork_instance: 1, fork_lineage: 'root:f' },
      { fork_instance: 2, fork_lineage: 'root:f' },
    ]);
  });

  it('two forks that share a destination and visit number never cross-correlate', () => {
    const ctx = harness(forkJoinDoc());
    // Different fork sources (different lineages) both reach visit 1 at the
    // join. Under a destination+visit correlation they would merge into one
    // wrong firing of four arrivals; the full-stack key keeps them apart.
    for (const [idx, lineage] of ['root:x', 'root:y'].entries()) {
      insertGraphToken(ctx.db, {
        revisionId: ctx.revisionId,
        sourceNodeRunId: 300 + idx * 2,
        isEntry: false,
        edgeId: 'b1-j',
        destinationNodeId: 'j',
        destinationEnd: false,
        forkInstance: 1,
        forkLineage: lineage,
        now: ctx.now,
      });
      insertGraphToken(ctx.db, {
        revisionId: ctx.revisionId,
        sourceNodeRunId: 400 + idx * 2,
        isEntry: false,
        edgeId: 'b2-j',
        destinationNodeId: 'j',
        destinationEnd: false,
        forkInstance: 1,
        forkLineage: lineage,
        now: ctx.now,
      });
    }
    const result = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(result.claimed).toBe(2);
    const joinRuns = ctx.db
      .prepare("SELECT visit_number FROM approach_node_runs WHERE node_id = 'j' ORDER BY visit_number")
      .all() as { visit_number: number }[];
    expect(joinRuns.map((r) => r.visit_number)).toEqual([1, 2]);
  });

  it('a partial arrival set never fires — and a stray iteration arrival cannot complete another', () => {
    const ctx = harness(forkJoinDoc());
    insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: 100,
      isEntry: false,
      edgeId: 'b1-j',
      destinationNodeId: 'j',
      destinationEnd: false,
      forkInstance: 1,
      forkLineage: 'root:f',
      now: ctx.now,
    });
    insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: 210,
      isEntry: false,
      edgeId: 'b2-j',
      destinationNodeId: 'j',
      destinationEnd: false,
      forkInstance: 2,
      forkLineage: 'root:f',
      now: ctx.now,
    });
    const partial = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(partial.claimed).toBe(0);
    expect(runIdForNode(ctx.db, ctx.revisionId, 'j')).toBeUndefined();
    // Completing iteration 1's pair fires ONE join; iteration 2 stays partial.
    insertGraphToken(ctx.db, {
      revisionId: ctx.revisionId,
      sourceNodeRunId: 200,
      isEntry: false,
      edgeId: 'b2-j',
      destinationNodeId: 'j',
      destinationEnd: false,
      forkInstance: 1,
      forkLineage: 'root:f',
      now: ctx.now,
    });
    const one = runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    expect(one.claimed).toBe(1);
    const joinRuns = ctx.db
      .prepare("SELECT visit_number FROM approach_node_runs WHERE node_id = 'j'")
      .all() as { visit_number: number }[];
    expect(joinRuns.map((r) => r.visit_number)).toEqual([1]);
    // The remaining partial group (iteration 2) is still pending and the join
    // NEVER fires a second time — a later tick may claim the fired join's
    // successor (node b), but the join stays at one firing.
    runCoordinatorTick(ctx.makeDeps(), { graphRunId: ctx.graphRunId });
    const after = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM approach_node_runs WHERE node_id = 'j'")
      .get() as { n: number };
    expect(after.n).toBe(1);
    const stray = ctx.db
      .prepare(
        "SELECT status FROM approach_graph_tokens WHERE edge_id = 'b2-j' AND fork_instance = 2",
      )
      .get() as { status: string };
    expect(stray.status).toBe('pending');
  });
});

describe('join firing under two windows (Slice 5 T4)', () => {
  /** Opens a SECOND connection to the shared file; the first call creates the
   *  graph run and revision that both windows then drive. */
  function windowHarness(path: string, seed?: { graphRunId: number; revisionId: number }) {
    const store = openStore(path);
    store.db.pragma('busy_timeout = 0');
    const db = store.db;
    let graphRunId: number;
    let revisionId: number;
    if (seed) {
      graphRunId = seed.graphRunId;
      revisionId = seed.revisionId;
    } else {
      const ticketId = Number(
        db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
      );
      graphRunId = Number(
        db
          .prepare(
            `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
             VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
          )
          .run(ticketId)
          .lastInsertRowid,
      );
      revisionId = Number(
        db
          .prepare(
            `INSERT INTO approach_graph_revisions
               (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
             VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
          )
          .run(graphRunId, doc([agent('b1'), agent('b2'), joinNode('j', ['b1', 'b2'])], [
            { id: 'b1-j', from: 'b1', on: 'complete', to: 'j' },
            { id: 'b2-j', from: 'b2', on: 'complete', to: 'j' },
            { id: 'j-end', from: 'j', on: 'complete', to: 'END' },
          ], ['b1', 'b2']))
          .lastInsertRowid,
      );
    }
    const now = '2026-08-12T00:00:00.000Z';
    const transaction = <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
        fn,
        { begin: 'immediate' },
      )();
    return { db, graphRunId, revisionId, now, transaction };
  }

  function claimedEntryFor(
    db: ReturnType<typeof openStore>['db'],
    revisionId: number,
    edgeId: string,
    destination: string,
    nodeRunId: number,
  ): void {
    db.prepare(
      `INSERT INTO approach_graph_tokens
         (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id,
          destination_end, fork_instance, fork_lineage, status, created_at)
       VALUES (?, NULL, 1, ?, ?, 0, 0, 'root', 'claimed', '2026-08-12T00:00:00.000Z')`,
    ).run(revisionId, edgeId, destination);
    db.prepare('UPDATE approach_graph_tokens SET claiming_node_run_id = ? WHERE edge_id = ?').run(
      nodeRunId,
      edgeId,
    );
  }

  it('arrivals split across two windows\' completion transactions fire exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-lineage-windows-'));
    const file = join(dir, 'shared.db');
    try {
      const a = windowHarness(file);
      const b = windowHarness(file, { graphRunId: a.graphRunId, revisionId: a.revisionId });
      // Each window completes ONE predecessor in its own transaction.
      a.db
        .prepare(
          `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (11, ?, ?, 'b1', 'agent', 1, 'completed')`,
        )
        .run(a.graphRunId, a.revisionId);
      claimedEntryFor(a.db, a.revisionId, 'entry-b1', 'b1', 11);
      const completedA = completeActivation(
        { db: a.db, transaction: a.transaction, now: () => a.now },
        { nodeRunId: 11, effectiveOutcome: 'complete' },
      );
      expect(completedA).toEqual({ consumed: 1, inserted: 1 });

      b.db
        .prepare(
          `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (12, ?, ?, 'b2', 'agent', 1, 'completed')`,
        )
        .run(b.graphRunId, b.revisionId);
      claimedEntryFor(b.db, b.revisionId, 'entry-b2', 'b2', 12);
      const completedB = completeActivation(
        { db: b.db, transaction: b.transaction, now: () => b.now },
        { nodeRunId: 12, effectiveOutcome: 'complete' },
      );
      expect(completedB).toEqual({ consumed: 1, inserted: 1 });

      // Both arrivals are now committed. ONE join firing claims both.
      const arrivals = a.db
        .prepare(
          "SELECT id FROM approach_graph_tokens WHERE destination_node_id = 'j' AND status = 'pending' ORDER BY id",
        )
        .all() as { id: number }[];
      expect(arrivals).toHaveLength(2);
      const fired = claimJoinActivation(
        { db: a.db, transaction: a.transaction, now: () => a.now },
        {
          tokenIds: arrivals.map((t) => t.id),
          outgoing: {
            edgeId: 'j-end',
            destinationNodeId: 'END',
            destinationEnd: true,
            forkInstance: 0,
            forkLineage: 'root',
          },
        },
      );
      expect(fired.claimed).toBe(true);
      const claimed = a.db
        .prepare(
          "SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE destination_node_id = 'j' AND status = 'claimed'",
        )
        .get() as { n: number };
      expect(claimed.n).toBe(2);
      const joinRuns = a.db
        .prepare("SELECT COUNT(*) AS n FROM approach_node_runs WHERE node_id = 'j'")
        .get() as { n: number };
      expect(joinRuns.n).toBe(1);
      const endToken = a.db
        .prepare("SELECT status FROM approach_graph_tokens WHERE edge_id = 'j-end'")
        .get() as { status: string };
      expect(endToken.status).toBe('pending');

      // A raced firing from the OTHER window is refused and rolls back — the
      // arrivals are already claimed, so the exact-row check aborts it.
      const raced = b.db
        .prepare(
          "SELECT id FROM approach_graph_tokens WHERE destination_node_id = 'j' ORDER BY id",
        )
        .all() as { id: number }[];
      expect(() =>
        claimJoinActivation(
          { db: b.db, transaction: b.transaction, now: () => b.now },
          {
            tokenIds: raced.map((t) => t.id),
            outgoing: {
              edgeId: 'j-end',
              destinationNodeId: 'END',
              destinationEnd: true,
              forkInstance: 0,
              forkLineage: 'root',
            },
          },
        ),
      ).toThrow(GraphClaimError);
      const after = b.db
        .prepare("SELECT COUNT(*) AS n FROM approach_node_runs WHERE node_id = 'j'")
        .get() as { n: number };
      expect(after.n).toBe(1); // still exactly one firing
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
