/**
 * Session re-attach identity tests (Slice 3 Task 7 follow-up).
 *
 * A graph session's transport registry is in-memory and recreated fresh on
 * every activation, while the terminals themselves survive a reload. The
 * coordinator re-attaches a live session by matching a revived terminal's
 * `KARST_LAUNCH_ID` (the node/planner run id) against the active graph's live
 * runs — the SAME gate `adoptionSurface` enforces — and rebuilding the durable
 * session identity from the run + process rows. This module is that pure read;
 * the terminal wrapper and the `adopt` call are the host's.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import type { GraphDb } from '../../../store/graph/transitions.js';
import { reattachableSessionIdentity } from './reattach.js';

const NOW = '2026-08-13T00:00:00.000Z';

interface Ctx {
  store: Store;
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
}

function setup(db: ReturnType<typeof openStore>['db']): {
  ticketId: number;
  graphRunId: number;
  revisionId: number;
} {
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key) VALUES ('R-1')").run().lastInsertRowid,
  );
  db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
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
  return { ticketId, graphRunId, revisionId };
}

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  return { store, db, ...setup(db) };
}

function insertNodeRun(ctx: Ctx, id: number, status: string, processRunId: number | null): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, process_run_id, generation, owner_nonce, started_at)
       VALUES (?, ?, ?, 'n', 'agent', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, id, status, processRunId, `gen-${id}`, `nonce-${id}`, NOW);
}

function insertPlannerRun(ctx: Ctx, id: number, status: string, processRunId: number | null): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, status, process_run_id, generation, owner_nonce, started_at)
       VALUES (?, ?, 1, 'bootstrap', ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.graphRunId, status, processRunId, `gen-${id}`, `nonce-${id}`, NOW);
}

function linkProcess(ctx: Ctx, processRunId: number, pid: number | null, startedAt = NOW): void {
  ctx.db
    .prepare(
      `INSERT INTO process_runs
         (id, ticket_id, stage_key, process_id, attempt, pid, status, started_at)
       VALUES (?, ?, 'impl', 'graph-node', 0, ?, 'running', ?)`,
    )
    .run(processRunId, ctx.ticketId, pid, startedAt);
}

describe('reattachableSessionIdentity', () => {
  let ctx: Ctx;
  afterEach(() => ctx.store.close());

  it('returns the durable identity of a live node run when its launchId adopts', () => {
    ctx = harness();
    linkProcess(ctx, 201, 4242);
    insertNodeRun(ctx, 11, 'running', 201);
    const identity = reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '11' });
    expect(identity).toEqual({
      kind: 'node',
      nodeRunId: 11,
      graphRunId: ctx.graphRunId,
      processRunId: 201,
      pid: 4242,
      startedAt: NOW,
      generation: 'gen-11',
      ownerNonce: 'nonce-11',
    });
  });

  it('returns the durable identity of a live planner run', () => {
    ctx = harness();
    linkProcess(ctx, 202, 4343);
    insertPlannerRun(ctx, 21, 'running', 202);
    const identity = reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '21' });
    expect(identity).toEqual({
      kind: 'planner',
      nodeRunId: 21,
      graphRunId: ctx.graphRunId,
      processRunId: 202,
      pid: 4343,
      startedAt: NOW,
      generation: 'gen-21',
      ownerNonce: 'nonce-21',
    });
  });

  it('re-attaches a PLANNING graph run\'s live planner session — the reported stuck-at-planner-1 scenario', () => {
    ctx = harness();
    ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('planning', ctx.graphRunId);
    linkProcess(ctx, 203, 4545);
    insertPlannerRun(ctx, 31, 'running', 203);
    const identity = reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '31' });
    expect(identity).toEqual({
      kind: 'planner',
      nodeRunId: 31,
      graphRunId: ctx.graphRunId,
      processRunId: 203,
      pid: 4545,
      startedAt: NOW,
      generation: 'gen-31',
      ownerNonce: 'nonce-31',
    });
  });

  it('refuses a terminal whose launchId matches no live run (completed node)', () => {
    ctx = harness();
    insertNodeRun(ctx, 12, 'completed', null);
    expect(reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '12' })).toBeUndefined();
  });

  it('refuses a submitted planner run (the session already delivered)', () => {
    ctx = harness();
    insertPlannerRun(ctx, 22, 'submitted', null);
    expect(reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '22' })).toBeUndefined();
  });

  it('refuses a launchId with no active graph for the ticket', () => {
    ctx = harness();
    ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('closed', ctx.graphRunId);
    insertNodeRun(ctx, 13, 'running', null);
    expect(reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '13' })).toBeUndefined();
  });

  it('refuses a non-numeric launchId and an unknown run id', () => {
    ctx = harness();
    expect(reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: 'abc' })).toBeUndefined();
    expect(reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '999' })).toBeUndefined();
  });

  it('falls back to the run row started_at when no process_runs row is linked', () => {
    ctx = harness();
    insertNodeRun(ctx, 14, 'running', null);
    const identity = reattachableSessionIdentity(ctx.db, { ticketId: ctx.ticketId, launchId: '14' });
    expect(identity?.pid).toBeNull();
    expect(identity?.startedAt).toBe(NOW);
  });
});
