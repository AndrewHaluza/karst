/**
 * T1333 — the scheduler lease snapshot reports whether the lease's OWNER is
 * still live. The sweep's deferral ceiling reads this (H4): a live holder keeps
 * a bounded long wait, a parked/dead/ambiguous/missing holder keeps the short
 * one. Liveness is the owner node run's durable status — reconcile already
 * moves a dead process to `stale`/`termination-unknown`, so the sweep never
 * probes a process.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { NODE_RUN_TRANSITIONS } from './transitions.js';
import {
  LIVE_NODE_RUN_STATUSES,
  acquireLease,
  heldLeasesForScheduler,
  markLeaseAmbiguous,
} from './leases.js';

const NOW = '2026-09-29T00:00:00.000Z';

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
}

function harness(): Harness {
  const { db } = openStore(':memory:');
  db.pragma('busy_timeout = 0');
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', ?)`,
      )
      .run(ticketId, NOW).lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, NOW).lastInsertRowid,
  );
  return { db, graphRunId, revisionId };
}

function insertNodeRun(h: Harness, status: string, nodeId = 'owner'): number {
  const res = h.db
    .prepare(
      `INSERT INTO approach_node_runs
         (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, 'agent', 1, ?)`,
    )
    .run(h.graphRunId, h.revisionId, nodeId, status);
  return Number(res.lastInsertRowid);
}

function holdLease(h: Harness, ownerNodeRunId: number, domain = 'dom-a'): number {
  return acquireLease(h.db, {
    graphRunId: h.graphRunId,
    ownerNodeRunId,
    physicalDomain: domain,
    accessMode: 'write',
    claimedPaths: null,
    now: NOW,
  });
}

/** Every status the node-run transition map knows, split by liveness. The
 *  union assertion below fails when a status is added and not classified. */
const LIVE = ['launching', 'running', 'completing', 'integrating'];
const NOT_LIVE = [
  'ready',
  'waiting-resource',
  'completed',
  'blocked',
  'output-artifact-missing',
  'artifact-unsafe',
  'failed-to-launch',
  'launch-unknown',
  'termination-unknown',
  'stale',
  'cancelled',
];

describe('heldLeasesForScheduler owner liveness (T1333)', () => {
  it('exports exactly the live node-run statuses', () => {
    expect([...LIVE_NODE_RUN_STATUSES]).toEqual(LIVE);
  });

  it('classifies every node-run status exactly once', () => {
    expect([...LIVE, ...NOT_LIVE].sort()).toEqual(Object.keys(NODE_RUN_TRANSITIONS).sort());
  });

  it.each(LIVE)('a held lease owned by a %s node run is live', (status) => {
    const h = harness();
    const owner = insertNodeRun(h, status);
    holdLease(h, owner);
    expect(heldLeasesForScheduler(h.db)).toEqual([
      {
        physicalDomain: 'dom-a',
        accessMode: 'write',
        ambiguous: false,
        paths: [],
        ownerLive: true,
      },
    ]);
  });

  it.each(NOT_LIVE)('a held lease owned by a %s node run is not live', (status) => {
    const h = harness();
    const owner = insertNodeRun(h, status);
    holdLease(h, owner);
    expect(heldLeasesForScheduler(h.db)[0]!.ownerLive).toBe(false);
  });

  it('a lease whose owner row is missing is not live', () => {
    const h = harness();
    // The owner FK normally forbids an orphan; disable it just for this insert
    // to model a row the reader must still classify (never throw, never live).
    h.db.pragma('foreign_keys = OFF');
    const leaseId = holdLease(h, 424242);
    h.db.pragma('foreign_keys = ON');
    expect(leaseId).toBeGreaterThan(0);
    const lease = heldLeasesForScheduler(h.db)[0]!;
    expect(lease.ownerLive).toBe(false);
    expect(lease.ambiguous).toBe(false);
  });

  it('an ambiguous-process lease is never live, even when the owner node run is running', () => {
    const h = harness();
    const owner = insertNodeRun(h, 'running');
    holdLease(h, owner);
    expect(markLeaseAmbiguous(h.db, owner)).toBe(1);
    expect(heldLeasesForScheduler(h.db)).toEqual([
      {
        physicalDomain: 'dom-a',
        accessMode: 'write',
        ambiguous: true,
        paths: [],
        ownerLive: false,
      },
    ]);
  });

  it('excludes released leases', () => {
    const h = harness();
    const owner = insertNodeRun(h, 'running');
    holdLease(h, owner);
    h.db.prepare("UPDATE approach_resource_leases SET status = 'released'").run();
    expect(heldLeasesForScheduler(h.db)).toEqual([]);
  });
});
