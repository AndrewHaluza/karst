/**
 * cancelGraphRun: one Cancel operation for a graph run in any non-terminal
 * status (T1133). Reproduces T1107: planning run, planner run `running`,
 * process_run `interrupted`, pid alive.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import type { ProcessFactsSource } from '../../runtime/serverIdentity.js';
import { cancelGraphRun, type CancelGraphRunDeps } from './cancel.js';

const STARTED = '2026-08-12T00:00:00.000Z';
const STARTED_MS = Date.parse(STARTED);
const NOW = '2026-08-12T01:00:00.000Z';

type Db = ReturnType<typeof openStore>['db'];

interface Ctx {
  db: Db;
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  kills: number[];
  deps: (over?: Partial<CancelGraphRunDeps>) => CancelGraphRunDeps;
}

function aliveFacts(pids: number[], startMs: number | null = STARTED_MS): ProcessFactsSource {
  return { isAlive: (pid) => pids.includes(pid), liveCwd: () => null, processStartMs: () => startMs };
}

function harness(status: string): Ctx {
  const db = openStore(':memory:').db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, ?)`,
      )
      .run(ticketId, status, STARTED).lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, STARTED).lastInsertRowid,
  );
  const kills: number[] = [];
  const deps = (over: Partial<CancelGraphRunDeps> = {}): CancelGraphRunDeps => ({
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
        begin: 'immediate',
      })(),
    facts: aliveFacts([]),
    killTree: (pid) => {
      kills.push(pid);
      return 'killed';
    },
    now: () => NOW,
    ...over,
  });
  return { db, ticketId, graphRunId, revisionId, kills, deps };
}

function processRun(ctx: Ctx, pid: number | null, status: string): number {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, pid, status, started_at)
         VALUES (?, 'impl', 'graph', 0, ?, ?, ?)`,
      )
      .run(ctx.ticketId, pid, status, STARTED).lastInsertRowid,
  );
}

function planner(ctx: Ctx, status: string, processRunId: number | null): number {
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, process_run_id)
         VALUES (?, 1, 'bootstrap', ?, ?)`,
      )
      .run(ctx.graphRunId, status, processRunId).lastInsertRowid,
  );
}

let visit = 0;
function node(ctx: Ctx, status: string, processRunId: number | null): number {
  visit += 1;
  return Number(
    ctx.db
      .prepare(
        `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status, process_run_id)
         VALUES (?, ?, 'a', 'agent', ?, ?, ?)`,
      )
      .run(ctx.graphRunId, ctx.revisionId, visit, status, processRunId).lastInsertRowid,
  );
}

const statusOf = (ctx: Ctx, table: string, id: number): string =>
  (ctx.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;

describe('cancelGraphRun', () => {
  it.each(['planning', 'running', 'draining', 'blocked'])(
    'cancels a run from %s',
    async (status) => {
      const ctx = harness(status);
      const result = await cancelGraphRun(ctx.deps(), ctx.graphRunId, 'user cancel');
      expect(result).toMatchObject({ outcome: 'cancelled', killed: 0 });
      expect(statusOf(ctx, 'approach_graph_runs', ctx.graphRunId)).toBe('cancelled');
    },
  );

  it.each(['closed', 'stale', 'cancelled'])('reports already-terminal for %s and writes nothing', async (status) => {
    const ctx = harness(status);
    const result = await cancelGraphRun(ctx.deps(), ctx.graphRunId, 'x');
    expect(result).toMatchObject({ outcome: 'already-terminal', status });
    expect(statusOf(ctx, 'approach_graph_runs', ctx.graphRunId)).toBe(status);
  });

  it('T1107: kills a live planner whose process_run was closed interrupted, then cancels', async () => {
    const ctx = harness('planning');
    const pr = processRun(ctx, 46559, 'interrupted');
    const plannerId = planner(ctx, 'running', pr);
    const result = await cancelGraphRun(ctx.deps({ facts: aliveFacts([46559]) }), ctx.graphRunId, 'stop');
    expect(result).toMatchObject({ outcome: 'cancelled', killed: 1, counts: { plannerRuns: 1 } });
    expect(ctx.kills).toEqual([46559]);
    expect(statusOf(ctx, 'approach_planner_runs', plannerId)).toBe('cancelled');
    expect(statusOf(ctx, 'approach_graph_runs', ctx.graphRunId)).toBe('cancelled');
  });

  it('refuses on a foreign pid: no kill, no row changed', async () => {
    const ctx = harness('planning');
    const pr = processRun(ctx, 777, 'running');
    const plannerId = planner(ctx, 'running', pr);
    const result = await cancelGraphRun(
      ctx.deps({ facts: aliveFacts([777], STARTED_MS + 60_000) }),
      ctx.graphRunId,
      'stop',
    );
    expect(result).toMatchObject({
      outcome: 'refused-live-process',
      refusals: [{ kind: 'planner', runId: plannerId, pid: 777, reason: 'foreign' }],
    });
    expect(ctx.kills).toEqual([]);
    expect(statusOf(ctx, 'approach_graph_runs', ctx.graphRunId)).toBe('planning');
    expect(statusOf(ctx, 'approach_planner_runs', plannerId)).toBe('running');
    expect(statusOf(ctx, 'process_runs', pr)).toBe('running');
  });

  it('refuses on an unknown pid (no start time evidence) and signals nothing', async () => {
    const ctx = harness('running');
    const pr = processRun(ctx, 778, 'running');
    node(ctx, 'running', pr);
    const result = await cancelGraphRun(ctx.deps({ facts: aliveFacts([778], null) }), ctx.graphRunId, 'x');
    expect(result).toMatchObject({ outcome: 'refused-live-process', refusals: [{ reason: 'unknown' }] });
    expect(ctx.kills).toEqual([]);
  });

  it('refuses when the kill is denied and changes no row', async () => {
    const ctx = harness('running');
    node(ctx, 'running', processRun(ctx, 779, 'running'));
    const result = await cancelGraphRun(
      ctx.deps({ facts: aliveFacts([779]), killTree: () => 'denied' }),
      ctx.graphRunId,
      'x',
    );
    expect(result).toMatchObject({ outcome: 'refused-live-process', refusals: [{ reason: 'kill-denied' }] });
    expect(statusOf(ctx, 'approach_graph_runs', ctx.graphRunId)).toBe('running');
  });

  it('cancels non-terminal node runs, releases held leases, closes running process_runs', async () => {
    const ctx = harness('running');
    const pr = processRun(ctx, 55, 'running');
    const live = node(ctx, 'running', pr);
    const done = node(ctx, 'completed', null);
    const lease = (id: number, status: string): void => {
      ctx.db
        .prepare(
          `INSERT INTO approach_resource_leases (graph_run_id, owner_node_run_id, physical_domain, access_mode, status, acquired_at)
           VALUES (?, ?, ?, 'write', ?, ?)`,
        )
        .run(ctx.graphRunId, id, `d${id}`, status, STARTED);
    };
    lease(live, 'held');
    lease(done, 'released');
    const result = await cancelGraphRun(ctx.deps(), ctx.graphRunId, 'stop');
    expect(result).toMatchObject({
      outcome: 'cancelled',
      counts: { plannerRuns: 0, nodeRuns: 1, leases: 1, processRuns: 1 },
    });
    expect(statusOf(ctx, 'approach_node_runs', live)).toBe('cancelled');
    expect(statusOf(ctx, 'approach_node_runs', done)).toBe('completed');
    expect(statusOf(ctx, 'process_runs', pr)).toBe('interrupted');
    const row = ctx.db
      .prepare(`SELECT status, released_at FROM approach_resource_leases WHERE owner_node_run_id = ?`)
      .get(live) as { status: string; released_at: string };
    expect(row).toEqual({ status: 'released', released_at: NOW });
  });

  it('reports raced when another window moved the run between read and write', async () => {
    const ctx = harness('planning');
    const plannerId = planner(ctx, 'running', null);
    const result = await cancelGraphRun(
      ctx.deps({
        transaction: <T>(fn: () => T): T => {
          ctx.db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = ?").run(ctx.graphRunId);
          return fn();
        },
      }),
      ctx.graphRunId,
      'stop',
    );
    expect(result).toMatchObject({ outcome: 'raced' });
    expect(statusOf(ctx, 'approach_planner_runs', plannerId)).toBe('running');
    expect(statusOf(ctx, 'approach_graph_runs', ctx.graphRunId)).toBe('blocked');
  });
});
