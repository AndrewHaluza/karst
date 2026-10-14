import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { graphLaunchIdentity } from './graphLaunchIdentity.js';

/**
 * The high review finding (T693): `openProcessRun` resolved the launch identity
 * by trying the NODE table first and falling back to the PLANNER table, so a
 * planner-run id that collided with an unrelated node-run id was attributed to
 * that node — mislabelling the `process_runs` row AND linking it to the wrong
 * node. `graphLaunchIdentity` keys off the request's own `runKind`.
 */
function seed(): ReturnType<typeof openStore> {
  const store = openStore(':memory:');
  store.db.prepare("INSERT INTO tickets (id, key) VALUES (1, 'T-1')").run();
  store.db
    .prepare(
      `INSERT INTO approach_graph_runs (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (2, 1, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO approach_graph_revisions (id, graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (3, 2, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
    )
    .run();
  // A node run and a planner run that SHARE id 11 — the collision.
  store.db
    .prepare(
      `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, profile, provider, model)
       VALUES (11, 2, 3, 'n', 'agent', 1, 'ready', 'node-profile', 'node-provider', 'node-model')`,
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO approach_planner_runs (id, graph_run_id, planner_run_number, kind, status, profile, provider, model)
       VALUES (11, 2, 1, 'replan', 'running', 'planner-profile', 'planner-provider', 'planner-model')`,
    )
    .run();
  return store;
}

describe('graphLaunchIdentity', () => {
  it('a planner launch resolves to the PLANNER row even when a node run shares the id', () => {
    const store = seed();
    const resolved = graphLaunchIdentity(store.db, { nodeRunId: 11, runKind: 'planner' });
    expect(resolved).toEqual({
      kind: 'planner',
      identity: { id: 11, profile: 'planner-profile', provider: 'planner-provider', model: 'planner-model' },
    });
    store.close();
  });

  it('a node launch (or a missing runKind) resolves to the NODE row', () => {
    const store = seed();
    expect(graphLaunchIdentity(store.db, { nodeRunId: 11, runKind: 'node' })).toEqual({
      kind: 'node',
      identity: { id: 11, profile: 'node-profile', provider: 'node-provider', model: 'node-model' },
    });
    expect(graphLaunchIdentity(store.db, { nodeRunId: 11 })).toEqual({
      kind: 'node',
      identity: { id: 11, profile: 'node-profile', provider: 'node-provider', model: 'node-model' },
    });
    store.close();
  });

  it('returns undefined when the named row is absent in its own table', () => {
    const store = seed();
    expect(graphLaunchIdentity(store.db, { nodeRunId: 99, runKind: 'node' })).toBeUndefined();
    expect(graphLaunchIdentity(store.db, { nodeRunId: 99, runKind: 'planner' })).toBeUndefined();
    store.close();
  });
});
