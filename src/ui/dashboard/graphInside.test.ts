/**
 * Host-side graph Inside builder (Slice 3 Task 11): a READ over the graph
 * tables plus the manifest's limits and the transport's live sessions. The
 * projection must be null for a ticket with no graph run, and every field it
 * renders must come from a persisted row or a proven live session — never an
 * invented identity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { DEFAULT_GRAPH_LIMITS } from '../../manifest/graphConfig.js';
import type { Manifest } from '../../manifest/types.js';
import type {
  SupervisedAgentSession,
  TransportTerminal,
} from '../../approaches/graph/transport/agentTransport.js';
import { buildGraphInsideInput, type GraphInsideDeps } from './graphInside.js';

let store: Store;

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
  store.db
    .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, ?)')
    .run(1, 'G-1', 'Graph', 1);
  store.db
    .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, ?)')
    .run(2, 'G-2', 'Plain', 1);
});
afterEach(() => store.close());

function fakeTerminal(): TransportTerminal {
  return {
    processId: () => Promise.resolve(42),
    show: () => undefined,
    sendText: () => undefined,
    dispose: () => undefined,
    onDidClose: () => undefined,
  };
}

function session(over: Partial<SupervisedAgentSession> = {}): SupervisedAgentSession {
  return {
    nodeRunId: 1,
    ticketId: 1,
    graphRunId: 1,
    pid: 42,
    cwd: '/wt',
    generation: 'gen-1',
    ownerNonce: 'nonce',
    startedAt: null,
    processRunId: null,
    providerSessionId: null,
    terminal: fakeTerminal(),
    ...over,
  };
}

function seedGraph(
  over: { ticketId?: number; status?: string; approachId?: string } = {},
): { graphRunId: number; revisionId: number } {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, ?, ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(
        over.ticketId ?? 1,
        over.approachId ?? 'karst-graph-engineering',
        over.status ?? 'running',
      )
      .lastInsertRowid,
  );
  const revisionId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId)
      .lastInsertRowid,
  );
  return { graphRunId, revisionId };
}

function deps(over: Partial<GraphInsideDeps> = {}): GraphInsideDeps {
  return {
    store,
    manifest: () => undefined,
    liveSessions: () => [],
    now: () => '2026-08-12T01:00:00.000Z',
    ...over,
  };
}

describe('buildGraphInsideInput', () => {
  it('is null for a ticket with no graph run', () => {
    expect(buildGraphInsideInput(deps(), 2)).toBeNull();
  });

  it('renders the run, planner runs, node runs, active revision and artifacts', () => {
    const { graphRunId, revisionId } = seedGraph({});
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (graph_run_id, planner_run_number, kind, status, compile_attempt, reason)
         VALUES (?, 1, 'bootstrap', 'submitted', 2, 'fixed a node')`,
      )
      .run(graphRunId);
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status,
            provider, model, effort, profile, launch_attempt)
         VALUES (?, ?, 'worker', 'agent', 1, 'running',
                 'codex', 'sol', 'high', 'default', 2)`,
      )
      .run(graphRunId, revisionId);
    store.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, artifact_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, 'a-1', '/tmp/a', 'sha', 'text/markdown', 2048, '2026-08-12T00:30:00.000Z')`,
      )
      .run(graphRunId);

    const input = buildGraphInsideInput(deps(), 1)!;
    expect(input.enabled).toBe(true);
    expect(input.graphRun).toMatchObject({ id: graphRunId, status: 'running' });
    expect(input.plannerRuns).toEqual([
      {
        plannerRunNumber: 1,
        kind: 'bootstrap',
        status: 'submitted',
        compileAttempt: 2,
        reason: 'fixed a node',
      },
    ]);
    expect(input.nodeRuns).toEqual([
      {
        nodeRunId: 1,
        nodeId: 'worker',
        nodeKind: 'agent',
        visitNumber: 1,
        status: 'running',
        outcome: null,
        reason: null,
        provider: 'codex',
        model: 'sol',
        effort: 'high',
        profile: 'default',
        launchAttempt: 2,
      },
    ]);
    expect(input.revision).toEqual({ revisionNumber: 1, status: 'active', fingerprint: 'fp' });
    expect(input.artifacts).toEqual([
      {
        artifactId: 'a-1',
        byteSize: 2048,
        mediaType: 'text/markdown',
        createdAt: '2026-08-12T00:30:00.000Z',
      },
    ]);
    // No graph block in the manifest → the packaged defaults stand.
    expect(input.execution).toEqual({
      maxParallel: DEFAULT_GRAPH_LIMITS.maxParallel,
      maxNodeRuns: DEFAULT_GRAPH_LIMITS.maxNodeRuns,
    });
  });

  it('resolves the execution policy from the manifest graph limits', () => {
    seedGraph({});
    const manifest = {
      approaches: [
        {
          id: 'karst-graph-engineering',
          label: 'g',
          enabled: true,
          graph: {
            planner: { profile: 'expert' },
            profiles: {},
            commands: {},
            limits: { ...DEFAULT_GRAPH_LIMITS, maxParallel: 2, maxNodeRuns: 50 },
          },
        },
      ],
    } as Manifest;
    const input = buildGraphInsideInput(deps({ manifest: () => manifest }), 1)!;
    expect(input.execution).toEqual({ maxParallel: 2, maxNodeRuns: 50 });
  });

  it('lists only live sessions whose run row exists in THIS run, kind proven', () => {
    const { graphRunId, revisionId } = seedGraph({});
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (11, ?, ?, 'worker', 'agent', 1, 'running')`,
      )
      .run(graphRunId, revisionId);
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (id, graph_run_id, planner_run_number, kind, status)
         VALUES (22, ?, 1, 'bootstrap', 'running')`,
      )
      .run(graphRunId);

    const input = buildGraphInsideInput(
      deps({
        liveSessions: () => [
          session({ nodeRunId: 11, graphRunId }), // node — proven
          session({ nodeRunId: 22, graphRunId }), // planner — proven
          session({ nodeRunId: 99, graphRunId }), // no row — unprovable, dropped
          session({ nodeRunId: 11, graphRunId: 999 }), // another run — dropped
        ],
      }),
      1,
    )!;
    expect(input.liveSessions).toEqual([
      { kind: 'node', runId: 11 },
      { kind: 'planner', runId: 22 },
    ]);
  });

  it('reads only the ACTIVE revision', () => {
    const { graphRunId } = seedGraph({});
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 2, '{}', 'fp2', 'superseded', '2026-08-12T00:10:00.000Z')`,
      )
      .run(graphRunId);
    const input = buildGraphInsideInput(deps(), 1)!;
    expect(input.revision?.revisionNumber).toBe(1);
  });
});
