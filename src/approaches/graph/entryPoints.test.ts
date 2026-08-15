/**
 * Entry-point matrix tests (Slice 3 Task 7).
 *
 * One test per matrix row: openSession reveals (never spawns) while the graph
 * is active, including while awaiting the implementation marker; nudge
 * is a no-op; adoption matches only live node/planner runs; driveTicket is
 * not invoked for a graph ticket at impl; resumeFix is unreachable at impl.
 * Stop drains the graph and terminates its processes.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import {
  ACTIVE_GRAPH_STATUSES,
  activeGraphRunFor,
  stoppableGraphRunFor,
  graphTicketSurface,
  nudgeSurface,
  shouldDriveGraphTicket,
  adoptionSurface,
  stopActiveGraph,
  type StopActiveGraphDeps,
} from './entryPoints.js';
import type { AgentTransport, SupervisedAgentSession } from './transport/supervisedCliTransport.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  makeDeps: (overrides?: Partial<StopActiveGraphDeps>) => StopActiveGraphDeps;
}

function harness(runStatus = 'running'): Ctx {
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
         VALUES (?, 'impl', 0, 'karst-graph-engineering', ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, runStatus)
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
  const base: StopActiveGraphDeps = {
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
        fn,
        { begin: 'immediate' },
      )(),
    transport: fakeTransport(),
    sessionsFor: () => [],
  };
  return { db, ticketId, graphRunId, revisionId, makeDeps: (overrides) => ({ ...base, ...overrides }) };
}

function fakeTransport(): AgentTransport {
  return {
    capabilities: () => ({ exactModel: false, attributedTermination: true }),
    start: async () => {
      throw new Error('unused');
    },
    terminate: async () => ({ kind: 'attributable', kill: 'killed' }),
  };
}

function insertNodeRun(ctx: Ctx, id: number, status: string): void {
  const visit = (
    ctx.db
      .prepare(
        "SELECT COALESCE(MAX(visit_number), 0) + 1 AS next FROM approach_node_runs WHERE revision_id = ? AND node_id = 'a'",
      )
      .get(ctx.revisionId) as { next: number }
  ).next;
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, 'a', 'agent', ?, ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, visit, status);
}

describe('openSession surface', () => {
  it('detects the active graph run BEFORE the generic session surface', () => {
    const ctx = harness('running');
    expect(graphTicketSurface(ctx.db, ctx.ticketId)).toBe('active-graph');
    expect(activeGraphRunFor(ctx.db, ctx.ticketId)).toEqual({
      graphRunId: ctx.graphRunId,
      status: 'running',
    });
    for (const status of ACTIVE_GRAPH_STATUSES) {
      const other = harness(status);
      expect(graphTicketSurface(other.db, other.ticketId)).toBe('active-graph');
    }
  });

  it('keeps a run awaiting the implementation marker on the graph surface', () => {
    const ctx = harness('completed-awaiting-impl-marker');
    expect(graphTicketSurface(ctx.db, ctx.ticketId)).toBe('active-graph');
    expect(activeGraphRunFor(ctx.db, ctx.ticketId)).toEqual({
      graphRunId: ctx.graphRunId,
      status: 'completed-awaiting-impl-marker',
    });
  });

  it('no graph run → the normal surface', () => {
    const ctx = harness();
    ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('closed', ctx.graphRunId);
    expect(graphTicketSurface(ctx.db, ctx.ticketId)).toBe('none');
  });
});

describe('nudge surface', () => {
  it('is a no-op while the graph is active; nudges otherwise', () => {
    const ctx = harness('running');
    expect(nudgeSurface(ctx.db, ctx.ticketId)).toBe('no-op');
    ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('closed', ctx.graphRunId);
    expect(nudgeSurface(ctx.db, ctx.ticketId)).toBe('nudge');
  });
});

describe('adoption surface', () => {
  it('adopts only terminals whose KARST_LAUNCH_ID matches a live node/planner run', () => {
    const ctx = harness('running');
    insertNodeRun(ctx, 11, 'running');
    insertNodeRun(ctx, 12, 'completed');
    expect(adoptionSurface(ctx.db, ctx.ticketId, '11')).toBe('adopt');
    expect(adoptionSurface(ctx.db, ctx.ticketId, '12')).toBe('refuse');
    expect(adoptionSurface(ctx.db, ctx.ticketId, '13')).toBe('refuse');
    expect(adoptionSurface(ctx.db, ctx.ticketId, 'not-a-number')).toBe('refuse');
    // A live planner run adopts too.
    ctx.db
      .prepare(
        `INSERT INTO approach_planner_runs (id, graph_run_id, planner_run_number, kind, status)
         VALUES (21, ?, 1, 'bootstrap', 'running')`,
      )
      .run(ctx.graphRunId);
    expect(adoptionSurface(ctx.db, ctx.ticketId, '21')).toBe('adopt');
  });

  it('without an active graph the legacy surface applies', () => {
    const ctx = harness('closed');
    expect(adoptionSurface(ctx.db, ctx.ticketId, '11')).toBe('legacy');
  });
});

describe('driveTicket surface', () => {
  it('is not invoked for a graph ticket with an active run; drives otherwise', () => {
    const ctx = harness('running');
    expect(shouldDriveGraphTicket(ctx.db, ctx.ticketId)).toBe(false);
    ctx.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run('closed', ctx.graphRunId);
    expect(shouldDriveGraphTicket(ctx.db, ctx.ticketId)).toBe(true);
  });
});

describe('stop (coordinator-level controller)', () => {
  it('finds a blocked graph for Stop without treating it as a runnable graph', () => {
    const ctx = harness('blocked');
    expect(activeGraphRunFor(ctx.db, ctx.ticketId)).toBeUndefined();
    expect(stoppableGraphRunFor(ctx.db, ctx.ticketId)).toEqual({
      graphRunId: ctx.graphRunId,
      status: 'blocked',
    });
  });

  it('finds only the graph run named by a Stop capability, never the latest ticket run', () => {
    const ctx = harness('blocked');
    const newerRunId = Number(
      ctx.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 1, 'karst-graph-engineering', 'running', '2026-08-15T00:00:00.000Z')`,
        )
        .run(ctx.ticketId)
        .lastInsertRowid,
    );

    expect(stoppableGraphRunFor(ctx.db, ctx.ticketId, ctx.graphRunId)).toEqual({
      graphRunId: ctx.graphRunId,
      status: 'blocked',
    });
    expect(stoppableGraphRunFor(ctx.db, ctx.ticketId, newerRunId)).toEqual({
      graphRunId: newerRunId,
      status: 'running',
    });
    expect(stoppableGraphRunFor(ctx.db, ctx.ticketId, 999)).toBeUndefined();
  });

  it('terminates every running node process and drains the graph — never blocked', async () => {
    const ctx = harness('running');
    const terminated: number[] = [];
    const sessions: SupervisedAgentSession[] = [
      { nodeRunId: 11 } as SupervisedAgentSession,
      { nodeRunId: 12 } as SupervisedAgentSession,
    ];
    const deps = ctx.makeDeps({
      sessionsFor: () => sessions,
      transport: {
        capabilities: () => ({ exactModel: false, attributedTermination: true }),
        start: async () => {
          throw new Error('unused');
        },
        terminate: async (session) => {
          terminated.push(session.nodeRunId);
          return session.nodeRunId === 12
            ? { kind: 'attributable', kill: 'denied' }
            : { kind: 'attributable', kill: 'killed' };
        },
      },
    });
    const result = await stopActiveGraph(deps, { ticketId: ctx.ticketId, graphRunId: ctx.graphRunId });
    expect(result).toMatchObject({ drained: true, terminated: 1, refused: 1 });
    expect(terminated).toEqual([11, 12]);
    const run = ctx.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string };
    expect(run.status).toBe('draining');
  });

  it('drains only from running; a non-running graph is not moved', async () => {
    const ctx = harness('blocked');
    const result = await stopActiveGraph(ctx.makeDeps(), {
      ticketId: ctx.ticketId,
      graphRunId: ctx.graphRunId,
    });
    expect(result.drained).toBe(false);
    const run = ctx.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(ctx.graphRunId) as { status: string };
    expect(run.status).toBe('blocked');
  });
});
