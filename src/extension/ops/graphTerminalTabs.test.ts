import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { createRevision } from '../../store/graph/revisions.js';
import { createNodeRun } from '../../store/graph/nodeRuns.js';
import { createPlannerRun } from '../../store/graph/plannerRuns.js';
import type { SupervisedAgentSession, TerminationProof } from '../../approaches/graph/transport/agentTransport.js';
import { createGraphTabClosers, graphSessionNameOf } from './graphTerminalTabs.js';

const NOW = '2026-08-12T00:00:00.000Z';

function world() {
  const store = openStore(':memory:');
  const db = store.db;
  const projectId = Number(db.prepare("INSERT INTO projects (slug, name) VALUES ('p1', 'P1')").run().lastInsertRowid);
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key, project_id, stage_current) VALUES ('T-1', ?, 'impl')").run(projectId)
      .lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 1, 'karst-graph-engineering', 'running', ?)`,
      )
      .run(ticketId, NOW).lastInsertRowid,
  );
  const revisionId = createRevision(db, {
    graphRunId,
    revisionNumber: 1,
    canonicalGraph: '{}',
    fingerprint: 'fp',
    status: 'active',
    now: NOW,
  });
  const node = (nodeId: string): number =>
    createNodeRun(db, { graphRunId, revisionId, nodeId, nodeKind: 'agent', visitNumber: 1, now: NOW });
  return { db, ticketId, graphRunId, node };
}

describe('graphSessionNameOf', () => {
  const logs: string[] = [];
  const naming = (w: ReturnType<typeof world>, ticketNameOf = () => 'Karst: T1 — fix') => ({
    db: () => w.db,
    ticketNameOf,
    debug: (m: string) => logs.push(m),
  });

  it('names a planner and a node, with the attempt on a relaunch', () => {
    const w = world();
    const nodeRunId = w.node('api-schema');
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    expect(graphSessionNameOf(naming(w), w.graphRunId, plannerRunId, 'planner')).toBe('Karst: T1 — fix · planner');
    expect(graphSessionNameOf(naming(w), w.graphRunId, nodeRunId, 'node')).toBe('Karst: T1 — fix · api-schema');
    w.db.prepare('UPDATE approach_node_runs SET launch_attempt = 3 WHERE id = ?').run(nodeRunId);
    expect(graphSessionNameOf(naming(w), w.graphRunId, nodeRunId, 'node')).toBe('Karst: T1 — fix · api-schema #3');
  });

  it('sanitizes a hostile node id', () => {
    const w = world();
    const nodeRunId = w.node('evil‮\nname');
    expect(graphSessionNameOf(naming(w), w.graphRunId, nodeRunId, 'node')).toBe('Karst: T1 — fix · evil name');
  });

  it('falls back to the opaque name when the ticket is gone', () => {
    const w = world();
    const name = graphSessionNameOf(
      naming(w, () => {
        throw new Error('gone');
      }),
      w.graphRunId,
      5,
      'planner',
    );
    expect(name).toBe('Karst planner 5');
    expect(logs.some((l) => l.includes('gone'))).toBe(true);
  });

  it('keeps the role suffix when the run facts cannot be read', () => {
    const w = world();
    const db = {
      prepare: () => {
        throw new Error('locked');
      },
    } as unknown as ReturnType<typeof world>['db'];
    expect(graphSessionNameOf({ ...naming(w), db: () => db }, w.graphRunId, 5, 'planner')).toBe('Karst: T1 — fix · planner');
    expect(graphSessionNameOf({ ...naming(w), db: () => db }, w.graphRunId, 5, 'node')).toBe('Karst: T1 — fix · node 5');
  });

  it('reads node facts only for a node and planner facts only for a planner', () => {
    const w = world();
    const nodeRunId = w.node('shared');
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    w.db.prepare('UPDATE approach_node_runs SET launch_attempt = 4 WHERE id = ?').run(nodeRunId);
    expect(plannerRunId).toBe(nodeRunId);
    expect(graphSessionNameOf(naming(w), w.graphRunId, plannerRunId, 'planner')).toBe('Karst: T1 — fix · planner');
  });

  it('names a node run the store does not know by its run id', () => {
    const w = world();
    expect(graphSessionNameOf(naming(w), w.graphRunId, 999, 'node')).toBe('Karst: T1 — fix · node 999');
    expect(graphSessionNameOf({ ...naming(w), db: () => undefined }, w.graphRunId, 5, 'node')).toBe(
      'Karst: T1 — fix · node 5',
    );
  });

  it('logs the unreadable run facts', () => {
    const w = world();
    logs.length = 0;
    const db = {
      prepare: () => {
        throw new Error('locked');
      },
    } as unknown as ReturnType<typeof world>['db'];
    graphSessionNameOf({ ...naming(w), db: () => db }, w.graphRunId, 5, 'node');
    expect(logs).toEqual(['graph session naming: run facts unreadable: Error: locked']);
  });

  it('uses the plain role when no database is open', () => {
    const w = world();
    expect(graphSessionNameOf({ ...naming(w), db: () => undefined }, w.graphRunId, 5, 'planner')).toBe(
      'Karst: T1 — fix · planner',
    );
  });
});

describe('createGraphTabClosers', () => {
  function closers(w: ReturnType<typeof world>, proof: TerminationProof = { kind: 'dead' }) {
    const disposed: number[] = [];
    const looked: Array<[number, number]> = [];
    const errors: string[] = [];
    const sessions = new Map<string, SupervisedAgentSession>();
    const c = createGraphTabClosers({
      db: () => w.db,
      transport: () => ({
        sessionFor: (t, r) => {
          looked.push([t, r]);
          return sessions.get(`${t}:${r}`);
        },
        terminate: async () => proof,
        disposeOnSuccess: (s) => disposed.push(s.nodeRunId),
      }),
      ticketIdOf: () => w.ticketId,
      debug: () => {},
      logError: (m) => errors.push(m),
    });
    const add = (runId: number) =>
      sessions.set(`${w.ticketId}:${runId}`, { ticketId: w.ticketId, nodeRunId: runId } as SupervisedAgentSession);
    return { c, disposed, errors, add, looked };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('closes a node tab on integrated only', () => {
    const w = world();
    const nodeRunId = w.node('a');
    const k = closers(w);
    k.add(nodeRunId);
    k.c.node(w.graphRunId, nodeRunId, { kind: 'termination-unknown' });
    expect(k.disposed).toEqual([]);
    k.c.node(w.graphRunId, nodeRunId, { kind: 'integrated', committed: true });
    expect(k.disposed).toEqual([nodeRunId]);
  });

  it('closes the accepted bootstrap planner tab after the process is proven ended', async () => {
    const w = world();
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    w.db.prepare("UPDATE approach_planner_runs SET status = 'submitted', ended_at = ? WHERE id = ?").run(NOW, plannerRunId);
    const k = closers(w);
    k.add(plannerRunId);
    k.c.bootstrapPlanner(w.graphRunId);
    await tick();
    expect(k.disposed).toEqual([plannerRunId]);
  });

  it('keeps the planner tab open when no accepted planner run exists', async () => {
    const w = world();
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    const k = closers(w);
    k.add(plannerRunId);
    k.c.bootstrapPlanner(w.graphRunId);
    await tick();
    expect(k.disposed).toEqual([]);
  });

  it('closes the accepted replan planner tab, found by its revision', async () => {
    const w = world();
    const plannerRunId = createPlannerRun(w.db, {
      graphRunId: w.graphRunId,
      plannerRunNumber: 2,
      kind: 'replan',
      targetRevisionNumber: 2,
    });
    w.db.prepare("UPDATE approach_planner_runs SET status = 'submitted' WHERE id = ?").run(plannerRunId);
    const k = closers(w);
    k.add(plannerRunId);
    k.c.replanPlanner(w.graphRunId, 3);
    await tick();
    expect(k.disposed).toEqual([]);
    k.c.replanPlanner(w.graphRunId, 2);
    await tick();
    expect(k.disposed).toEqual([plannerRunId]);
  });

  it('never closes a node session that shares the planner run id', async () => {
    const w = world();
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    w.db.prepare("UPDATE approach_planner_runs SET status = 'submitted', ended_at = ? WHERE id = ?").run(NOW, plannerRunId);
    // A node run with the same numeric id as the planner run.
    let nodeRunId = w.node('n');
    while (nodeRunId < plannerRunId) nodeRunId = w.node('n');
    const k = closers(w);
    k.add(plannerRunId);
    k.c.bootstrapPlanner(w.graphRunId);
    await tick();
    if (nodeRunId === plannerRunId) expect(k.disposed).toEqual([]);
  });

  it('never closes a planner session that shares the node run id', () => {
    const w = world();
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    let nodeRunId = w.node('n');
    while (nodeRunId < plannerRunId) nodeRunId = w.node('n');
    expect(nodeRunId).toBe(plannerRunId); // the two tables count ids on their own
    const k = closers(w);
    k.add(nodeRunId); // the live planner session holds the shared key
    k.c.node(w.graphRunId, nodeRunId, { kind: 'integrated', committed: true });
    expect(k.disposed).toEqual([]);
  });

  it('keeps a node tab open when the database is missing', () => {
    const w = world();
    const nodeRunId = w.node('a');
    const k = closers(w);
    k.add(nodeRunId);
    const noDb = createGraphTabClosers({
      db: () => undefined,
      transport: () => ({
        sessionFor: () => ({ ticketId: w.ticketId, nodeRunId } as SupervisedAgentSession),
        terminate: async () => ({ kind: 'dead' }),
        disposeOnSuccess: (s) => k.disposed.push(s.nodeRunId),
      }),
      ticketIdOf: () => w.ticketId,
      debug: () => {},
      logError: () => {},
    });
    noDb.node(w.graphRunId, nodeRunId, { kind: 'integrated', committed: true });
    expect(k.disposed).toEqual([]);
  });

  it('logs an error when the planner close fails', async () => {
    const w = world();
    const plannerRunId = createPlannerRun(w.db, { graphRunId: w.graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    w.db.prepare("UPDATE approach_planner_runs SET status = 'submitted', ended_at = ? WHERE id = ?").run(NOW, plannerRunId);
    const errors: string[] = [];
    const c = createGraphTabClosers({
      db: () => w.db,
      transport: () => ({
        sessionFor: () => {
          throw new Error('boom');
        },
        terminate: async () => ({ kind: 'dead' }),
        disposeOnSuccess: () => {},
      }),
      ticketIdOf: () => w.ticketId,
      debug: () => {},
      logError: (m) => errors.push(m),
    });
    c.bootstrapPlanner(w.graphRunId);
    await tick();
    expect(errors).toEqual([`karst: closing the planner terminal of graph run ${w.graphRunId} failed`]);
  });

  it('does nothing when only the transport or only the database is missing', () => {
    const w = world();
    const base = { ticketIdOf: () => w.ticketId, debug: () => {}, logError: () => {} };
    const noTransport = createGraphTabClosers({ ...base, db: () => w.db, transport: () => undefined });
    const noDb = createGraphTabClosers({
      ...base,
      db: () => undefined,
      transport: () => ({
        sessionFor: () => {
          throw new Error('must not run');
        },
        terminate: async () => ({ kind: 'dead' }),
        disposeOnSuccess: () => {},
      }),
    });
    expect(() => {
      noTransport.bootstrapPlanner(w.graphRunId);
      noDb.bootstrapPlanner(w.graphRunId);
    }).not.toThrow();
  });

  it('does nothing without a transport or a database', () => {
    const w = world();
    const c = createGraphTabClosers({
      db: () => undefined,
      transport: () => undefined,
      ticketIdOf: () => w.ticketId,
      debug: () => {},
      logError: () => {},
    });
    expect(() => {
      c.node(1, 1, { kind: 'integrated', committed: true });
      c.bootstrapPlanner(1);
      c.replanPlanner(1, 2);
    }).not.toThrow();
  });
});
