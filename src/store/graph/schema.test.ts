/**
 * Schema-level constraints over the v35 graph tables: closed-value CHECKs
 * reject out-of-set statuses, the remaining unique indexes reject their
 * duplicates, and the store helpers run driver-agnostically — the same
 * positional-`?` SQL works under better-sqlite3 AND node:sqlite (the CLI's
 * driver), pinned by running the identical sequence on both.
 */

import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, type Store } from '../db.js';
import { createGraphRun, graphRunById, transitionGraphRun } from './graphRuns.js';
import { createPlannerRun } from './plannerRuns.js';
import { createRevision } from './revisions.js';
import { createNodeRun, transitionNodeRun } from './nodeRuns.js';
import { createToken, type CreateToken } from './tokens.js';
import { acquireLease } from './leases.js';
import type { GraphDb } from './transitions.js';

function harness(): { store: Store; ticketId: number } {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  return { store, ticketId };
}

function graphRun(store: Store, ticketId: number, stageAttempt = 0): number {
  return createGraphRun(store.db, {
    ticketId,
    stageAttempt,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
}

function revision(store: Store, graphRunId: number, n: number): number {
  return createRevision(store.db, {
    graphRunId,
    revisionNumber: n,
    canonicalGraph: '{}',
    fingerprint: 'fp',
    status: 'active',
    now: '2026-08-11T00:00:00.000Z',
  });
}

describe('closed-value CHECKs', () => {
  it('approach_graph_runs rejects a status outside its closed set', () => {
    const { store, ticketId } = harness();
    expect(() =>
      store.db
        .prepare(
          'INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(ticketId, 'impl', 0, 'x', 'bogus', '2026-08-11T00:00:00.000Z'),
    ).toThrow(/CHECK/i);
  });

  it.each([
    'approach_planner_runs',
    'approach_graph_revisions',
    'approach_node_runs',
    'approach_graph_tokens',
    'approach_resource_leases',
  ] as const)('%s rejects a status outside its closed set', (table) => {
    const { store, ticketId } = harness();
    const runId = graphRun(store, ticketId);
    const revId = revision(store, runId, 1);
    const nodeId = createNodeRun(store.db, {
      graphRunId: runId,
      revisionId: revId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
      now: '2026-08-11T00:00:00.000Z',
    });

    const insert = (): void => {
      if (table === 'approach_planner_runs') {
        store.db
          .prepare(
            'INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?,?,?,?)',
          )
          .run(runId, 1, 'bootstrap', 'bogus');
      } else if (table === 'approach_graph_revisions') {
        store.db
          .prepare(
            'INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(runId, 2, '{}', 'fp', 'bogus', '2026-08-11T00:00:00.000Z');
      } else if (table === 'approach_node_runs') {
        store.db
          .prepare(
            'INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status) VALUES (?,?,?,?,?,?)',
          )
          .run(runId, revId, 'n2', 'agent', 1, 'bogus');
      } else if (table === 'approach_graph_tokens') {
        store.db
          .prepare(
            'INSERT INTO approach_graph_tokens (revision_id, source_node_run_id, is_entry, edge_id, destination_node_id, destination_end, fork_instance, fork_lineage, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          )
          .run(revId, null, 1, '$entry', 'start', 0, 0, null, 'bogus', '2026-08-11T00:00:00.000Z');
      } else {
        store.db
          .prepare(
            'INSERT INTO approach_resource_leases (graph_run_id, owner_node_run_id, physical_domain, access_mode, claimed_paths, status, acquired_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(runId, nodeId, 'domain', 'write', '[]', 'bogus', '2026-08-11T00:00:00.000Z');
      }
    };

    const before = (store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number })
      .c;
    expect(insert).toThrow(/CHECK/i);
    const after = (store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number })
      .c;
    expect(after).toBe(before); // the rejected insert added nothing
  });
});

describe('unique indexes', () => {
  it('one graph run per ticket/stage attempt', () => {
    const { store, ticketId } = harness();
    graphRun(store, ticketId, 0);
    expect(() => graphRun(store, ticketId, 0)).toThrow(/UNIQUE/i);
    // A different attempt is a different run (a re-scoped impl).
    expect(graphRun(store, ticketId, 1)).toBeGreaterThan(0);
  });

  it('one planner-run number per graph run', () => {
    const { store, ticketId } = harness();
    const runId = graphRun(store, ticketId);
    createPlannerRun(store.db, { graphRunId: runId, plannerRunNumber: 1, kind: 'bootstrap' });
    expect(() =>
      createPlannerRun(store.db, { graphRunId: runId, plannerRunNumber: 1, kind: 'bootstrap' }),
    ).toThrow(/UNIQUE/i);
  });

  it('one node visit per revision/node', () => {
    const { store, ticketId } = harness();
    const runId = graphRun(store, ticketId);
    const revId = revision(store, runId, 1);
    const insert = {
      graphRunId: runId,
      revisionId: revId,
      nodeId: 'n1',
      nodeKind: 'agent',
      now: '2026-08-11T00:00:00.000Z',
    };
    createNodeRun(store.db, { ...insert, visitNumber: 1 });
    expect(() => createNodeRun(store.db, { ...insert, visitNumber: 1 })).toThrow(/UNIQUE/i);
    // A retry reuses the VISIT (same reserved visit), incrementing only the
    // launch attempt — a second visit number would be a different row.
    expect(createNodeRun(store.db, { ...insert, visitNumber: 2 })).toBeGreaterThan(0);
  });

  it('one lease per (owner_node_run_id, physical_domain)', () => {
    const { store, ticketId } = harness();
    const runId = graphRun(store, ticketId);
    const revId = revision(store, runId, 1);
    const nodeId = createNodeRun(store.db, {
      graphRunId: runId,
      revisionId: revId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
      now: '2026-08-11T00:00:00.000Z',
    });
    acquireLease(store.db, {
      graphRunId: runId,
      ownerNodeRunId: nodeId,
      physicalDomain: '/wt/ticket',
      accessMode: 'write',
      claimedPaths: '[]',
      now: '2026-08-11T00:00:00.000Z',
    });
    expect(() =>
      acquireLease(store.db, {
        graphRunId: runId,
        ownerNodeRunId: nodeId,
        physicalDomain: '/wt/ticket',
        accessMode: 'read',
        claimedPaths: '[]',
        now: '2026-08-11T00:00:00.000Z',
      }),
    ).toThrow(/UNIQUE/i);
    // A different domain is a different lease.
    expect(
      acquireLease(store.db, {
        graphRunId: runId,
        ownerNodeRunId: nodeId,
        physicalDomain: '/wt/other',
        accessMode: 'read',
        claimedPaths: '[]',
        now: '2026-08-11T00:00:00.000Z',
      }),
    ).toBeGreaterThan(0);
  });

  it('entry-token shape + successor uniqueness hold on a fresh schema (schema.sql)', () => {
    // The same constraints must exist on a FRESH DB built from schema.sql —
    // the migration and the fresh path share one DDL text, pinned in db.test.
    const store = openStore(':memory:');
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    const runId = createGraphRun(store.db, {
      ticketId,
      stageAttempt: 0,
      approachId: 'x',
      now: '2026-08-11T00:00:00.000Z',
    });
    const revId = revision(store, runId, 1);
    const nodeId = createNodeRun(store.db, {
      graphRunId: runId,
      revisionId: revId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
      now: '2026-08-11T00:00:00.000Z',
    });
    const insert: CreateToken = {
      revisionId: revId,
      sourceNodeRunId: nodeId,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    };
    createToken(store.db, insert);
    // Slice-3 T1: successor insertion is IDEMPOTENT under a duplicated
    // completion — the second insert is ignored (undefined), never an error.
    expect(createToken(store.db, insert)).toBeUndefined();
    const rows = store.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE edge_id = ?')
      .get('e1') as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('driver-agnostic store helpers', () => {
  /** The identical mutation sequence run under both drivers. */
  function runSequence(db: GraphDb): { runId: number; status: string; tokens: number } {
    const ticketId = Number(
      db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    const runId = createGraphRun(db, {
      ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: '2026-08-11T00:00:00.000Z',
    });
    const revId = createRevision(db, {
      graphRunId: runId,
      revisionNumber: 1,
      canonicalGraph: '{}',
      fingerprint: 'fp',
      status: 'active',
      now: '2026-08-11T00:00:00.000Z',
    });
    const nodeId = createNodeRun(db, {
      graphRunId: runId,
      revisionId: revId,
      nodeId: 'n1',
      nodeKind: 'agent',
      visitNumber: 1,
      now: '2026-08-11T00:00:00.000Z',
    });
    const tokenId = createToken(db, {
      revisionId: revId,
      sourceNodeRunId: nodeId,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    })!;
    transitionGraphRun(db, runId, 'planning', 'running');
    const status = (graphRunById(db, runId) as { status: string }).status;
    return { runId, status, tokens: tokenId };
  }

  it('the same helpers behave identically under better-sqlite3 and node:sqlite', () => {
    // better-sqlite3 (extension host driver) — full schema via openStore.
    const better = openStore(':memory:');
    const a = runSequence(better.db);

    // node:sqlite (CLI driver) — schema.sql applied verbatim.
    const sync = new DatabaseSync(':memory:');
    sync.exec(readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8'));
    const b = runSequence(sync as unknown as GraphDb);

    expect(b).toEqual(a);
    // Positional-? contract: no named-param or pluck-style binding survived in
    // the helpers (the CLI opens the same store with node:sqlite).
    const helperSource = [
      'graphRuns.ts',
      'revisions.ts',
      'nodeRuns.ts',
      'tokens.ts',
      'leases.ts',
      'plannerRuns.ts',
    ]
      .map((f) => readFileSync(join(import.meta.dirname, f), 'utf8'))
      .join('\n');
    expect(helperSource).not.toMatch(/\.pluck\(/);
    expect(helperSource).not.toMatch(/namedParameters|named\s+params/);
  });
});
