/**
 * T1370 — the graph-session owner reads: which ticket and provider a graph
 * launch id, or a node workspace cwd, belongs to. The hook dispatcher uses
 * them to route a graph session's usage to the ledger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createTicket } from '../tickets.js';
import { openProcessRun, finishProcessRun } from '../processRuns.js';
import { graphLaunchOwner, graphWorkspaceForCwd } from './sessionOwners.js';

const T0 = '2026-11-26T10:00:00.000Z';
const WS = '/data/graph/7/workspaces/31/app';
const GEN = '019ab3c2-7d10-7e4f-8a2b-3c4d5e6f7a8b';

let store: Store;
let ticketId: number;

beforeEach(() => {
  store = openStore(':memory:');
  ticketId = createTicket(store, { key: 'T-1', title: 'one' }).id;
});
afterEach(() => store.close());

function seedRun(status = 'running'): void {
  store.db
    .prepare(
      `INSERT INTO approach_graph_runs
         (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (7, ?, 'impl', 1, 'graph', ?, ?)`,
    )
    .run(ticketId, status, T0);
  store.db
    .prepare(
      `INSERT INTO approach_graph_revisions
         (id, graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (1, 7, 1, 'graph: []', 'fp', 'active', ?)`,
    )
    .run(T0);
}

function processRun(provider: string, processId: string, closed = false): number {
  const run = openProcessRun(store, {
    ticketId,
    stageKey: 'impl',
    processId,
    attempt: 1,
    provider,
    model: 'm',
    startedAt: T0,
  });
  if (closed) finishProcessRun(store, run.id, 'passed', T0);
  return run.id;
}

function seedNode(processRunId: number | null): void {
  store.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number,
          status, process_run_id, profile, provider, model, generation)
       VALUES (31, 7, 1, 'n1', 'agent', 1, 'running', ?, 'worker', 'opencode2', 'm', ?)`,
    )
    .run(processRunId, GEN);
}

function seedPlanner(processRunId: number): void {
  store.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, status, process_run_id,
          profile, provider, model, generation)
       VALUES (4, 7, 1, 'bootstrap', 'running', ?, 'planner', 'claude', 'm', ?)`,
    )
    .run(processRunId, GEN);
}

function seedWorkspace(cwd = WS): void {
  store.db
    .prepare(
      `INSERT INTO approach_graph_workspaces
         (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (7, 31, 'app', ?, 10, ?)`,
    )
    .run(cwd, T0);
}

describe('graphLaunchOwner', () => {
  it('names the ticket and the running provider of a planner launch', () => {
    seedRun();
    seedPlanner(processRun('claude', 'graph-planner'));
    expect(graphLaunchOwner(store.db, { graphRunId: 7, runId: 4, role: 'planner' })).toEqual({
      ticketId,
      graphRunId: 7,
      runId: 4,
      role: 'planner',
      provider: 'claude',
    });
  });

  it('names the ticket and the running provider of a node launch', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node'));
    expect(graphLaunchOwner(store.db, { graphRunId: 7, runId: 31, role: 'node' })).toMatchObject({
      ticketId,
      role: 'node',
      provider: 'opencode2',
    });
  });

  it('matches a launch generation equal to the persisted one', () => {
    seedRun();
    seedPlanner(processRun('claude', 'graph-planner'));
    expect(
      graphLaunchOwner(store.db, { graphRunId: 7, runId: 4, role: 'planner', generation: GEN }),
    ).toMatchObject({ ticketId, provider: 'claude' });
  });

  it('refuses a launch generation that differs from the persisted one', () => {
    seedRun();
    seedPlanner(processRun('claude', 'graph-planner'));
    expect(
      graphLaunchOwner(store.db, {
        graphRunId: 7,
        runId: 4,
        role: 'planner',
        generation: '019ab3c2-0000-7e4f-8a2b-3c4d5e6f7a8b',
      }),
    ).toBeNull();
  });

  it('refuses a launch generation when the run has none persisted', () => {
    seedRun();
    seedPlanner(processRun('claude', 'graph-planner'));
    store.db.prepare('UPDATE approach_planner_runs SET generation = NULL WHERE id = 4').run();
    expect(
      graphLaunchOwner(store.db, { graphRunId: 7, runId: 4, role: 'planner', generation: GEN }),
    ).toBeNull();
  });

  it('reads the role table the role names, never the other one', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node'));
    expect(graphLaunchOwner(store.db, { graphRunId: 7, runId: 31, role: 'planner' })).toBeNull();
  });

  it('refuses a run of another graph run', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node'));
    expect(graphLaunchOwner(store.db, { graphRunId: 8, runId: 31, role: 'node' })).toBeNull();
  });

  it.each(['closed', 'cancelled', 'stale'])('refuses a %s graph run', (status) => {
    seedRun(status);
    seedNode(processRun('opencode2', 'graph-node'));
    expect(graphLaunchOwner(store.db, { graphRunId: 7, runId: 31, role: 'node' })).toBeNull();
  });

  it('keeps the ticket but no provider when the process run is closed', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node', true));
    expect(graphLaunchOwner(store.db, { graphRunId: 7, runId: 31, role: 'node' })).toMatchObject({
      ticketId,
      provider: null,
    });
  });

  it('keeps the ticket but no provider when the run has no process run', () => {
    seedRun();
    seedNode(null);
    expect(graphLaunchOwner(store.db, { graphRunId: 7, runId: 31, role: 'node' })).toMatchObject({
      ticketId,
      provider: null,
    });
  });
});

describe('graphWorkspaceForCwd', () => {
  it('maps a node workspace cwd to its ticket, graph run and node run', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node'));
    seedWorkspace();
    expect(graphWorkspaceForCwd(store.db, WS)).toEqual({
      ticketId,
      graphRunId: 7,
      nodeRunId: 31,
      cwd: WS,
    });
  });

  it('is null for a cwd no workspace row names', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node'));
    seedWorkspace();
    expect(graphWorkspaceForCwd(store.db, '/elsewhere')).toBeNull();
    expect(graphWorkspaceForCwd(store.db, `${WS}/src`)).toBeNull();
  });

  it.each(['closed', 'cancelled', 'stale'])('is null for a workspace of a %s graph run', (status) => {
    seedRun(status);
    seedNode(processRun('opencode2', 'graph-node'));
    seedWorkspace();
    expect(graphWorkspaceForCwd(store.db, WS)).toBeNull();
  });

  it('compares both sides through the injected canonical form', () => {
    seedRun();
    seedNode(processRun('opencode2', 'graph-node'));
    seedWorkspace('/link/31/app');
    const canonical = (p: string): string => p.replace(/^\/link\//, '/real/');
    expect(graphWorkspaceForCwd(store.db, '/real/31/app', canonical)).toMatchObject({
      nodeRunId: 31,
      cwd: '/link/31/app',
    });
    expect(graphWorkspaceForCwd(store.db, '/real/31/app')).toBeNull();
  });
});
