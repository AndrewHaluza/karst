/**
 * Durable physical-domain leases (Slice 5 Task 2).
 *
 * Integration and conflicting execution serialize on a durable
 * `approach_resource_leases` row with status `held`, acquired in the claim
 * transaction — never an in-memory mutex, because two windows may legitimately
 * complete different nodes concurrently. `UNIQUE(owner_node_run_id,
 * physical_domain)` is what makes the affected-row check enforcement rather
 * than convention.
 *
 * Lease transitions: `held → released` (termination proven and the change set
 * integrated), `held → ambiguous-process` (termination unprovable), and
 * `ambiguous-process → released` (ONLY via the discard action). No lease is
 * released while process termination is unknown.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../store/db.js';
import { acquireLease } from '../../../store/graph/leases.js';
import {
  acquireDomainLeases,
  releaseLeaseForNodeRun,
  markLeaseAmbiguous,
  type AcquireDomainLeasesDeps,
} from './leases.js';

const NOW = '2026-08-12T00:00:00.000Z';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  makeDeps: (overrides?: Partial<AcquireDomainLeasesDeps>) => AcquireDomainLeasesDeps;
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

function setup(
  db: ReturnType<typeof openStore>['db'],
): { graphRunId: number; revisionId: number; ticketId: number } {
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('L-1')").run().lastInsertRowid);
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
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, NOW)
      .lastInsertRowid,
  );
  return { graphRunId, revisionId, ticketId };
}

function harness(path: string = ':memory:'): Ctx {
  const store = openStore(path);
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const { graphRunId } = setup(db);
  const base: AcquireDomainLeasesDeps = { db, now: () => NOW };
  return {
    db,
    graphRunId,
    makeDeps: (overrides) => ({ ...base, ...overrides }),
  };
}

function nodeRun(ctx: Ctx, id: number): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, (SELECT id FROM approach_graph_revisions WHERE graph_run_id = ? LIMIT 1), ?, 'agent', 1, 'ready')`,
    )
    .run(id, ctx.graphRunId, ctx.graphRunId, `n${id}`);
}

function leaseRows(ctx: Ctx, ownerNodeRunId: number): { physical_domain: string; status: string; access_mode: string }[] {
  return ctx.db
    .prepare(
      'SELECT physical_domain, status, access_mode FROM approach_resource_leases WHERE owner_node_run_id = ? ORDER BY physical_domain',
    )
    .all(ownerNodeRunId) as { physical_domain: string; status: string; access_mode: string }[];
}

const DOMAIN = (d: string) => ({ physicalDomain: d, accessMode: 'write' as const });

describe('acquireDomainLeases', () => {
  it('inserts one held lease row per physical domain, in the claim transaction', () => {
    const ctx = harness();
    nodeRun(ctx, 1);
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 1,
        domains: [DOMAIN('dom-a'), DOMAIN('dom-b')],
      }),
    );
    expect(result).toEqual({ acquired: true, count: 2 });
    expect(leaseRows(ctx, 1)).toEqual([
      { physical_domain: 'dom-a', status: 'held', access_mode: 'write' },
      { physical_domain: 'dom-b', status: 'held', access_mode: 'write' },
    ]);
  });

  it('deduplicates repeated domain keys (aliased repository entries share one domain)', () => {
    const ctx = harness();
    nodeRun(ctx, 2);
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 2,
        domains: [DOMAIN('dom-x'), DOMAIN('dom-x'), { physicalDomain: 'dom-x', accessMode: 'read' }],
      }),
    );
    expect(result).toEqual({ acquired: true, count: 1 });
    expect(leaseRows(ctx, 2)).toEqual([
      { physical_domain: 'dom-x', status: 'held', access_mode: 'write' },
    ]);
  });

  it('two windows acquiring the same domain: one winner, the second is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-lease-race-'));
    const file = join(dir, 'shared.db');
    try {
      const ctxA = harness(file);
      const ctxB = harness(file);
      nodeRun(ctxA, 1);
      nodeRun(ctxB, 2);
      const winner = withImmediate(ctxA.db, () =>
        acquireDomainLeases(ctxA.makeDeps(), {
          graphRunId: ctxA.graphRunId,
          nodeRunId: 1,
          domains: [DOMAIN('dom-1')],
        }),
      );
      expect(winner).toEqual({ acquired: true, count: 1 });
      // Window B's transaction reads A's COMMITTED held row: refused, and the
      // refusal mutates nothing.
      const loser = withImmediate(ctxB.db, () =>
        acquireDomainLeases(ctxB.makeDeps(), {
          graphRunId: ctxB.graphRunId,
          nodeRunId: 2,
          domains: [DOMAIN('dom-1')],
        }),
      );
      expect(loser).toMatchObject({ acquired: false });
      expect(leaseRows(ctxA, 1)).toHaveLength(1);
      expect(leaseRows(ctxB, 2)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lease survives a host restart: a fresh store connection sees the held row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-lease-restart-'));
    const file = join(dir, 's.db');
    try {
      const first = harness(file);
      nodeRun(first, 3);
      withImmediate(first.db, () =>
        acquireDomainLeases(first.makeDeps(), {
          graphRunId: first.graphRunId,
          nodeRunId: 3,
          domains: [DOMAIN('dom-persist')],
        }),
      );
      first.db.close();
      // The "restarted host": a fresh Store connection to the SAME file. No
      // in-memory mutex survives — the durable row is the whole of the lease.
      const second = harness(file);
      expect(leaseRows(second, 3)).toEqual([
        { physical_domain: 'dom-persist', status: 'held', access_mode: 'write' },
      ]);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the domain is ambiguous-process in another owner (blocks a conflicting launch)', () => {
    const ctx = harness();
    nodeRun(ctx, 4);
    nodeRun(ctx, 5);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 4,
      physicalDomain: 'dom-shared',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE owner_node_run_id = ?")
      .run(4);
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 5,
        domains: [DOMAIN('dom-shared')],
      }),
    );
    expect(result).toMatchObject({ acquired: false });
    expect((result as { reason: string }).reason).toMatch(/dom-shared/);
    expect(leaseRows(ctx, 5)).toHaveLength(0);
  });

  it('a node run never conflicts with its own lease', () => {
    const ctx = harness();
    nodeRun(ctx, 6);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 6,
      physicalDomain: 'dom-own',
      accessMode: 'read',
      claimedPaths: null,
      now: NOW,
    });
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 6,
        domains: [DOMAIN('dom-other')],
      }),
    );
    expect(result).toEqual({ acquired: true, count: 1 });
  });

  it('read/read on the same domain may coexist (Slice 5 Task 3)', () => {
    const ctx = harness();
    nodeRun(ctx, 7);
    nodeRun(ctx, 8);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 7,
        domains: [{ physicalDomain: 'dom-shared', accessMode: 'read' }],
      }),
    );
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 8,
        domains: [{ physicalDomain: 'dom-shared', accessMode: 'read' }],
      }),
    );
    expect(result).toEqual({ acquired: true, count: 1 });
    expect(leaseRows(ctx, 7)).toEqual([{ physical_domain: 'dom-shared', status: 'held', access_mode: 'read' }]);
    expect(leaseRows(ctx, 8)).toEqual([{ physical_domain: 'dom-shared', status: 'held', access_mode: 'read' }]);
  });

  it('write/read on the same domain refuses — a writer blocks even a reader', () => {
    const ctx = harness();
    nodeRun(ctx, 9);
    nodeRun(ctx, 10);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 9,
        domains: [{ physicalDomain: 'dom-wr', accessMode: 'write' }],
      }),
    );
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 10,
        domains: [{ physicalDomain: 'dom-wr', accessMode: 'read' }],
      }),
    );
    expect(result).toMatchObject({ acquired: false });
  });

  it('path-disjoint claims on the same domain do not conflict — even write/write', () => {
    const ctx = harness();
    nodeRun(ctx, 11);
    nodeRun(ctx, 12);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 11,
        domains: [{ physicalDomain: 'dom-paths', accessMode: 'write', paths: ['src/'] }],
      }),
    );
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 12,
        domains: [{ physicalDomain: 'dom-paths', accessMode: 'write', paths: ['lib/'] }],
      }),
    );
    expect(result).toEqual({ acquired: true, count: 1 });
    expect(leaseRows(ctx, 11)).toEqual([{ physical_domain: 'dom-paths', status: 'held', access_mode: 'write' }]);
    expect(leaseRows(ctx, 12)).toEqual([{ physical_domain: 'dom-paths', status: 'held', access_mode: 'write' }]);
  });

  it('overlapping claims on the same domain refuse, whether write/write or write/read', () => {
    const ctx = harness();
    nodeRun(ctx, 13);
    nodeRun(ctx, 14);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 13,
        domains: [{ physicalDomain: 'dom-overlap', accessMode: 'write', paths: ['src/'] }],
      }),
    );
    const writeOverlap = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 14,
        domains: [{ physicalDomain: 'dom-overlap', accessMode: 'write', paths: ['src/lib/x.ts'] }],
      }),
    );
    expect(writeOverlap).toMatchObject({ acquired: false });
    const readOverlap = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 14,
        domains: [{ physicalDomain: 'dom-overlap', accessMode: 'read', paths: ['src/'] }],
      }),
    );
    expect(readOverlap).toMatchObject({ acquired: false });
  });

  it('a repository-wide lease (no paths) overlaps every path', () => {
    const ctx = harness();
    nodeRun(ctx, 15);
    nodeRun(ctx, 16);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 15,
        domains: [{ physicalDomain: 'dom-wide', accessMode: 'write' }],
      }),
    );
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 16,
        domains: [{ physicalDomain: 'dom-wide', accessMode: 'read', paths: ['deep/nested'] }],
      }),
    );
    expect(result).toMatchObject({ acquired: false });
  });

  it('an ambiguous-process lease blocks even a read/read arrival', () => {
    const ctx = harness();
    nodeRun(ctx, 17);
    nodeRun(ctx, 18);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 17,
      physicalDomain: 'dom-ambig-read',
      accessMode: 'read',
      claimedPaths: null,
      now: NOW,
    });
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE owner_node_run_id = ?")
      .run(17);
    const result = withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 18,
        domains: [{ physicalDomain: 'dom-ambig-read', accessMode: 'read' }],
      }),
    );
    expect(result).toMatchObject({ acquired: false });
    expect(leaseRows(ctx, 18)).toHaveLength(0);
  });
});

describe('releaseLeaseForNodeRun', () => {
  it('releases held leases (termination proven and integrated)', () => {
    const ctx = harness();
    nodeRun(ctx, 11);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 11,
        domains: [DOMAIN('dom-r1')],
      }),
    );
    const released = withImmediate(ctx.db, () => releaseLeaseForNodeRun(ctx.db, 11));
    expect(released).toBe(1);
    expect(leaseRows(ctx, 11)).toEqual([
      { physical_domain: 'dom-r1', status: 'released', access_mode: 'write' },
    ]);
  });

  it('an ambiguous-process lease is NOT released by the normal completion path', () => {
    const ctx = harness();
    nodeRun(ctx, 12);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 12,
      physicalDomain: 'dom-ambig',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE owner_node_run_id = ?")
      .run(12);
    // The completion/integration path never passes allowAmbiguous: the
    // ambiguous lease is left strictly alone — no release while termination
    // is unknown.
    const released = withImmediate(ctx.db, () => releaseLeaseForNodeRun(ctx.db, 12));
    expect(released).toBe(0);
    expect(leaseRows(ctx, 12)).toEqual([
      { physical_domain: 'dom-ambig', status: 'ambiguous-process', access_mode: 'write' },
    ]);
  });

  it('ambiguous-process → released happens ONLY through the discard action', () => {
    const ctx = harness();
    nodeRun(ctx, 13);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 13,
      physicalDomain: 'dom-discard',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE owner_node_run_id = ?")
      .run(13);
    const released = withImmediate(ctx.db, () =>
      releaseLeaseForNodeRun(ctx.db, 13, { allowAmbiguous: true }),
    );
    expect(released).toBe(1);
    expect(leaseRows(ctx, 13)).toEqual([
      { physical_domain: 'dom-discard', status: 'released', access_mode: 'write' },
    ]);
  });
});

describe('markLeaseAmbiguous', () => {
  it('flips held leases to ambiguous-process when termination is unprovable', () => {
    const ctx = harness();
    nodeRun(ctx, 21);
    withImmediate(ctx.db, () =>
      acquireDomainLeases(ctx.makeDeps(), {
        graphRunId: ctx.graphRunId,
        nodeRunId: 21,
        domains: [DOMAIN('dom-m1')],
      }),
    );
    const flipped = withImmediate(ctx.db, () => markLeaseAmbiguous(ctx.db, 21));
    expect(flipped).toBe(1);
    expect(leaseRows(ctx, 21)).toEqual([
      { physical_domain: 'dom-m1', status: 'ambiguous-process', access_mode: 'write' },
    ]);
  });

  it('never releases and never touches a lease already released or ambiguous', () => {
    const ctx = harness();
    nodeRun(ctx, 22);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 22,
      physicalDomain: 'dom-released',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    ctx.db.prepare("UPDATE approach_resource_leases SET status = 'released' WHERE owner_node_run_id = ?").run(22);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 22,
      physicalDomain: 'dom-already-ambig',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    ctx.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE physical_domain = ?")
      .run('dom-already-ambig');
    const flipped = withImmediate(ctx.db, () => markLeaseAmbiguous(ctx.db, 22));
    expect(flipped).toBe(0);
    const statuses = ctx.db
      .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ? ORDER BY physical_domain')
      .all(22) as { status: string }[];
    expect(statuses).toEqual([{ status: 'ambiguous-process' }, { status: 'released' }]);
  });
});

describe('unique index enforcement', () => {
  it('the unique (owner_node_run_id, physical_domain) index rejects a duplicate insert', () => {
    const ctx = harness();
    nodeRun(ctx, 31);
    acquireLease(ctx.db, {
      graphRunId: ctx.graphRunId,
      ownerNodeRunId: 31,
      physicalDomain: 'dom-unique',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    expect(() =>
      acquireLease(ctx.db, {
        graphRunId: ctx.graphRunId,
        ownerNodeRunId: 31,
        physicalDomain: 'dom-unique',
        accessMode: 'read',
        claimedPaths: null,
        now: NOW,
      }),
    ).toThrow(/UNIQUE/i);
  });
});
