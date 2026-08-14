/**
 * The graph-run host driver — the missing launch seam, pinned end to end.
 *
 * These tests drive the driver's real orchestration against the in-memory
 * store with faked transport/prompts/git, so the graph approach's launch
 * path is exercised as the extension host will call it.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../store/db.js';
import { graphApproachConfig } from '../../manifest/fixtures.js';
import type { GraphApproachConfig } from '../../manifest/types.js';
import type { CompileContext } from './compile.js';
import type { GraphDriverDeps, GraphDriverDeps as Deps } from './driver.js';
import {
  bootstrapAndLaunchPlanner,
  acceptSubmittedPlan,
  acceptSubmittedReplan,
  confirmGraphRun,
  driveReadyNodeRuns,
  launchReplanPlanner,
  relaunchBootstrapPlanner,
  sha256Hex,
} from './driver.js';
import type { SupervisedAgentSession, SupervisedLaunchRequest } from './transport/supervisedCliTransport.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { createGraphRun } from '../../store/graph/graphRuns.js';
import { createRevision } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';

const NOW = '2026-08-13T00:00:00.000Z';

/** A minimal valid graph: one gate reaching END on both outcomes. */
function gateGraphJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    title: 'Check',
    rationaleArtifact: 'plan',
    entries: ['check'],
    artifacts: [
      {
        id: 'plan',
        path: 'artifacts/plan.md',
        producer: '$planner',
        consumers: ['check'],
        mediaType: 'text/markdown',
        maxBytes: 1000,
        required: true,
      },
    ],
    nodes: [
      {
        id: 'check',
        kind: 'gate',
        label: 'Check',
        policy: { kind: 'expert-runs', op: 'gte', value: 0 },
        outcomes: ['matched', 'not-matched'],
        budget: { maxVisits: 1 },
      },
    ],
    edges: [
      { id: 'e1', from: 'check', on: 'matched', to: 'END' },
      { id: 'e2', from: 'check', on: 'not-matched', to: 'END' },
    ],
    budgets: { maxNodeRuns: 10, maxExpertRuns: 5, maxReplans: 2 },
    ...overrides,
  });
}

function compileContextOf(): CompileContext {
  return {
    profiles: new Map([
      ['worker', 'worker'],
      ['expert', 'expert'],
    ]),
    commands: new Map([
      ['test', { id: 'test', fingerprint: 'fp-test', access: 'write', timeoutSeconds: 60, permittedRepositories: ['api'] }],
    ]),
    repositories: new Map([['api', { id: 'api', root: '', domain: 'domain-api' }]]),
    artifactFileExists: () => true,
    expertSpend: { spentPlannerRuns: 0, permittedReplans: 0, bootstrapUnspent: true },
    projectMaxima: { maxNodeRuns: 200, maxExpertRuns: 10, maxReplans: 5 },
  };
}

function fakeAdapter(): AgentAdapter {
  return {
    requiredBinary: 'opencode',
    runHeadless: async () => ({ sessionId: 's', verdict: null, raw: '' }),
    buildInteractiveCommand: () => ({ command: 'opencode', args: [], env: {} }),
    capabilities: { lifecycleEvents: true, resume: true },
  };
}

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  root: string;
  ticketId: number;
  starts: Record<string, unknown>[];
  deps: Deps;
  config: GraphApproachConfig;
}

function harness(config: GraphApproachConfig = graphApproachConfig()): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const root = mkdtempSync(join(tmpdir(), 'karst-graph-driver-'));
  const starts: Record<string, unknown>[] = [];
  const session: SupervisedAgentSession = {
    nodeRunId: 0,
    ticketId,
    graphRunId: 0,
    pid: 1234,
    cwd: '',
    generation: 'g',
    ownerNonce: 'nonce',
    startedAt: NOW,
    processRunId: null,
    providerSessionId: null,
  };
  const transport = {
    capabilities: () => ({ exactModel: true, attributedTermination: true }),
    start: async (request: SupervisedLaunchRequest) => {
      starts.push(request as unknown as Record<string, unknown>);
      return { ...session, nodeRunId: request.nodeRunId, graphRunId: request.graphRunId, cwd: request.cwd };
    },
    terminate: async () => ({ kind: 'dead' }),
    sessions: () => [],
    sessionFor: () => undefined,
  } as unknown as Deps['transport'];
  const readBytes = (graphRunId: number, rel: string): Uint8Array | undefined => {
    try {
      return new Uint8Array(readFileSync(join(root, String(graphRunId), rel)));
    } catch {
      return undefined;
    }
  };
  const deps: Deps = {
    db,
    transaction: <T>(fn: () => T): T => store.db.transaction(fn)(),
    now: () => NOW,
    debug: () => undefined,
    graphConfigOf: (approachId) => (approachId === 'karst-graph-engineering' ? config : undefined),
    artifactRootOf: (graphRunId) => join(root, String(graphRunId)),
    graphEnvOf: (input) => ({
      KARST_GRAPH_RUN_ID: String(input.graphRunId),
      KARST_LAUNCH_ID: String(input.launchId),
      KARST_GRAPH_GENERATION: input.generation,
      KARST_GRAPH_CAPABILITY: input.capability,
      KARST_GRAPH_ARTIFACT_ROOT: input.artifactRoot,
    }),
    adapterFor: () => fakeAdapter(),
    transport,
    promptBytesOf: (identity) =>
      new TextEncoder().encode(identity === 'karst-graph-planner' ? '# Planner' : '# Node'),
    writeSnapshot: (graphRunId, rel, bytes) => {
      const target = join(root, String(graphRunId), rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    },
    readBytes,
    ticketContextOf: () => '# Ticket context',
    compileContextOf,
    commandDefOf: (_graphRunId, commandId) =>
      commandId === 'test'
        ? { command: 'true', args: [], cwd: 'repository', access: 'write', timeoutSeconds: 60 }
        : undefined,
    runProcess: async () => ({ kind: 'completed', exitCode: 0, output: '' }),
    plannerCwdOf: () => ({ repo: 'api', cwd: join(root, 'wt') }),
    cwdForRepo: (_graphRunId, repo) => join(root, `wt-${repo}`),
    workspaceOf: () => undefined,
    createWorkspace: async () => ({ kind: 'created', paths: [{ repoName: 'api', cwd: join(root, 'ws'), domainKey: 'd' }] }),
    sessionNameOf: (id, kind) => `${kind} ${id}`,
    cliNodeCompletionCommand: () => 'node "/ext/dist/cli/main.js" node complete',
  };
  return { db, root, ticketId, starts, deps, config };
}

function plannerRunIdFor(db: Harness['db'], graphRunId: number): number {
  return (
    db
      .prepare('SELECT id FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id LIMIT 1')
      .get(graphRunId) as { id: number }
  ).id;
}

/** A graph run in `running` (the state the coordinator + driver execute on). */
function runningGraphRun(h: Harness, graphRunId: number): void {
  h.db.prepare('UPDATE approach_graph_runs SET status = \'running\' WHERE id = ?').run(graphRunId);
}

describe('bootstrapAndLaunchPlanner', () => {
  it('creates the graph run + planner run, stamps capability, and launches the planner session', async () => {
    const h = harness();
    const result = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      projectSlug: 'acme',
    });
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    const run = h.db
      .prepare('SELECT status, approach_id FROM approach_graph_runs WHERE id = ?')
      .get(result.graphRunId) as { status: string; approach_id: string };
    expect(run.status).toBe('planning');
    expect(run.approach_id).toBe('karst-graph-engineering');
    const planner = h.db
      .prepare('SELECT status, generation, capability_hash, prompt_hash FROM approach_planner_runs WHERE id = ?')
      .get(result.plannerRunId) as {
      status: string;
      generation: string | null;
      capability_hash: string | null;
      prompt_hash: string | null;
    };
    expect(planner.status).toBe('running');
    expect(planner.generation).not.toBeNull();
    expect(planner.capability_hash).not.toBeNull();
    expect(planner.prompt_hash).not.toBeNull();
    expect(h.starts).toHaveLength(1);
    const launch = h.starts[0] as { nodeRunId: number; graphEnv: Record<string, string> };
    expect(launch.nodeRunId).toBe(result.plannerRunId);
    expect(launch.graphEnv.KARST_GRAPH_CAPABILITY).toBeTruthy();
    expect(
      (h.starts[0] as { interactive: { initialPrompt: string } }).interactive.initialPrompt,
    ).toContain('node "$KARST_GRAPH_CLI" graph submit');
  });

  it('returns instructions-missing when the planner prompt cannot be read', async () => {
    const h = harness();
    h.deps.promptBytesOf = () => undefined;
    const result = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      projectSlug: 'acme',
    });
    expect(result.kind).toBe('instructions-missing');
    expect(h.starts).toHaveLength(0);
  });

  it('returns no-config for an approach without a graph block', async () => {
    const h = harness();
    const result = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'direct',
      projectSlug: 'acme',
    });
    expect(result.kind).toBe('no-config');
    expect(h.starts).toHaveLength(0);
  });
});

describe('acceptSubmittedPlan', () => {
  it('compiles the submitted snapshot, persists revision 1 + entry tokens, and parks awaiting confirmation', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', 'fp1', ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'fp1.json'), gateGraphJson());
    // The planner's declared artifact exists at its staging path, so the
    // accept step snapshots and records it.
    const planDir = join(h.root, String(graphRunId), 'artifacts');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), '# plan');

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('awaiting-confirmation');
    const revision = h.db
      .prepare(
        'SELECT status, planner_graph_snapshot_id, planner_artifact_snapshot_id FROM approach_graph_revisions WHERE graph_run_id = ?',
      )
      .get(graphRunId) as { status: string; planner_graph_snapshot_id: string | null; planner_artifact_snapshot_id: string | null };
    expect(revision.status).toBe('active');
    expect(revision.planner_graph_snapshot_id).not.toBeNull(); // the compiled fingerprint
    expect(revision.planner_artifact_snapshot_id).toBe('fp1'); // the submitted snapshot
    const entries = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE is_entry = 1 AND status = \'pending\'')
      .get() as { n: number };
    expect(entries.n).toBe(1);
    const planArtifacts = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_artifact_instances WHERE artifact_id = \'plan\'')
      .get() as { n: number };
    expect(planArtifacts.n).toBe(1);
  });

  it('blocks the run with graph-plan-invalid for an uncompilable document', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', 'fp2', ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'fp2.json'), JSON.stringify({ version: 1, title: 'Bad', entries: [] }));

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('rejected');
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('graph-plan-invalid');
  });

  it('is a no-op for a run not in planning', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.db
      .prepare('UPDATE approach_graph_runs SET status = \'running\' WHERE id = ?')
      .run(graphRunId);
    expect(acceptSubmittedPlan(h.deps, graphRunId).kind).toBe('no-op');
  });
});

describe('confirmGraphRun', () => {
  it('moves awaiting-confirmation → running once', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    expect(confirmGraphRun(h.deps, graphRunId)).toBe(false); // still planning
    h.db.prepare('UPDATE approach_graph_runs SET status = \'awaiting-confirmation\' WHERE id = ?').run(graphRunId);
    expect(confirmGraphRun(h.deps, graphRunId)).toBe(true);
    expect(confirmGraphRun(h.deps, graphRunId)).toBe(false); // already running
  });
});

describe('driveReadyNodeRuns', () => {
  it('completes a gate node deterministically and emits its outcome successors', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: gateGraphJson(),
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const [entryTokenId] = insertEntryTokens(
      h.db,
      revisionId,
      [{ edgeId: 'entry-check', destinationNodeId: 'check', destinationEnd: false }],
      NOW,
    );
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, 'check', 'gate', 1, 'ready')`,
        )
        .run(graphRunId, revisionId)
        .lastInsertRowid,
    );
    h.db
      .prepare(
        `UPDATE approach_graph_tokens SET status = 'claimed', claiming_node_run_id = ? WHERE id = ?`,
      )
      .run(nodeRunId, entryTokenId);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.completed).toBe(1);
    const node = h.db
      .prepare('SELECT status, outcome FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string; outcome: string };
    expect(node.status).toBe('completed');
    expect(node.outcome).toBe('matched'); // expert-runs >= 0 always matches
    const endToken = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE destination_end = 1')
      .get() as { n: number };
    expect(endToken.n).toBe(1);
  });

  it('completes a command node from its exit code and releases its process slot', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
    const doc = gateGraphJson({
      entries: ['verify'],
      nodes: [
        {
          id: 'verify',
          kind: 'command',
          label: 'Verify',
          command: 'test',
          repositories: ['api'],
          outcomes: ['passed', 'failed', 'infrastructure-error'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [
        { id: 'e1', from: 'verify', on: 'passed', to: 'END' },
        { id: 'e2', from: 'verify', on: 'failed', to: 'END' },
      ],
    });
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: doc,
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const [tokenId] = insertEntryTokens(
      h.db,
      revisionId,
      [{ edgeId: 'entry-verify', destinationNodeId: 'verify', destinationEnd: false }],
      NOW,
    );
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, 'verify', 'command', 1, 'ready')`,
        )
        .run(graphRunId, revisionId)
        .lastInsertRowid,
    );
    h.db
      .prepare('UPDATE approach_graph_tokens SET status = \'claimed\', claiming_node_run_id = ? WHERE id = ?')
      .run(nodeRunId, tokenId);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.completed).toBe(1);
    const node = h.db
      .prepare('SELECT status, outcome FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string; outcome: string };
    expect(node.status).toBe('completed');
    expect(node.outcome).toBe('passed');
    const endToken = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE destination_end = 1')
      .get() as { n: number };
    expect(endToken.n).toBe(1);
  });

  it('launches an agent node with an isolated workspace and stamps its capability', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
    // A bootstrap planner run produces the instructions/input artifacts.
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', 'fp1', ?)`,
      )
      .run(graphRunId, NOW);
    const doc = gateGraphJson({
      entries: ['impl'],
      artifacts: [
        {
          id: 'plan',
          path: 'artifacts/plan.md',
          producer: '$planner',
          consumers: ['impl'],
          mediaType: 'text/markdown',
          maxBytes: 1000,
          required: true,
        },
        {
          id: 'task',
          path: 'artifacts/task.md',
          producer: '$planner',
          consumers: ['impl'],
          mediaType: 'text/markdown',
          maxBytes: 1000,
          required: true,
        },
      ],
      nodes: [
        {
          id: 'impl',
          kind: 'agent',
          label: 'Implement',
          profile: 'worker',
          instructionsArtifact: 'task',
          inputs: ['plan'],
          outputs: [],
          resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [
        { id: 'e1', from: 'impl', on: 'complete', to: 'END' },
        { id: 'e2', from: 'impl', on: 'blocked', to: 'END' },
      ],
    });
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: doc,
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const [tokenId] = insertEntryTokens(
      h.db,
      revisionId,
      [{ edgeId: 'entry-impl', destinationNodeId: 'impl', destinationEnd: false }],
      NOW,
    );
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, 'impl', 'agent', 1, 'ready')`,
        )
        .run(graphRunId, revisionId)
        .lastInsertRowid,
    );
    h.db
      .prepare('UPDATE approach_graph_tokens SET status = \'claimed\', claiming_node_run_id = ? WHERE id = ?')
      .run(nodeRunId, tokenId);
    // The instructions/inputs resolve from recorded planner instances.
    const artRoot = h.deps.artifactRootOf(graphRunId);
    for (const [id, name] of [['plan', 'plan.md'], ['task', 'task.md']] as const) {
      mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
      writeFileSync(join(artRoot, 'artifacts', name), `# ${id}`);
    }
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const planSnap = h.deps.readBytes(graphRunId, 'artifacts/plan.md')!;
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'plan', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/plan.md', sha256Hex(planSnap), planSnap.length, NOW);
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/task.md', sha256Hex(taskSnap), taskSnap.length, NOW);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.launched).toBe(1);
    const node = h.db
      .prepare('SELECT status, generation, capability_hash FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string; generation: string | null; capability_hash: string | null };
    expect(node.status).toBe('running');
    expect(node.generation).not.toBeNull();
    expect(node.capability_hash).not.toBeNull();
    const launch = h.starts[0] as { nodeRunId: number; graphEnv: Record<string, string> };
    expect(launch.nodeRunId).toBe(nodeRunId);
    expect(launch.graphEnv.KARST_GRAPH_CAPABILITY).toBeTruthy();
  });
});

describe('acceptSubmittedReplan', () => {
  it('lands revision N+1 and resumes a draining run from a submitted replan', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: '{}',
      fingerprint: 'old',
      status: 'draining',
      now: NOW,
    });
    h.db.prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?").run(graphRunId);
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 2, 'replan', 'submitted', 'rpl', ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'rpl.json'), gateGraphJson());

    const result = acceptSubmittedReplan(h.deps, graphRunId);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.revisionId).toBeGreaterThan(revisionId);
    expect(result.revisionNumber).toBe(2);
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('running');
    const superseded = h.db
      .prepare('SELECT status FROM approach_graph_revisions WHERE id = ?')
      .get(revisionId) as { status: string };
    expect(superseded.status).toBe('superseded');
    const entries = h.db
      .prepare("SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE is_entry = 1 AND status = 'pending'")
      .get() as { n: number };
    expect(entries.n).toBe(1);
  });
});

describe('launchReplanPlanner', () => {
  it('stamps and launches the elected replan planner', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
         VALUES (?, 2, 'replan', 'ready')`,
      )
      .run(graphRunId);
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const result = await launchReplanPlanner(h.deps, {
      graphRunId,
      plannerRunId,
      generation: '',
      capability: '',
      prompt: '# replan',
      cwd: join(h.root, 'wt'),
      repo: 'api',
    });
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    const planner = h.db
      .prepare('SELECT status, generation, capability_hash FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; generation: string | null; capability_hash: string | null };
    expect(planner.status).toBe('running');
    expect(planner.generation).not.toBeNull();
    expect(planner.capability_hash).not.toBeNull();
    expect(h.starts).toHaveLength(1);
  });
});

describe('relaunchBootstrapPlanner', () => {
  it('allocates a new bootstrap planner run (#2) on the existing planning run and launches it', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    // The dead bootstrap planner run #1 (the reconcile sweep marked it stale).
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
         VALUES (?, 1, 'bootstrap', 'stale')`,
      )
      .run(graphRunId);

    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    const planners = h.db
      .prepare(
        'SELECT planner_run_number, kind, status, generation, capability_hash, prompt_hash FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id',
      )
      .all(graphRunId) as {
      planner_run_number: number;
      kind: string;
      status: string;
      generation: string | null;
      capability_hash: string | null;
      prompt_hash: string | null;
    }[];
    expect(planners).toHaveLength(2);
    expect(planners[0]).toMatchObject({ planner_run_number: 1, kind: 'bootstrap', status: 'stale' });
    expect(planners[1]).toMatchObject({ planner_run_number: 2, kind: 'bootstrap', status: 'running' });
    expect(planners[1]!.generation).not.toBeNull();
    expect(planners[1]!.capability_hash).not.toBeNull();
    expect(planners[1]!.prompt_hash).not.toBeNull();
    // The run stays planning — the relaunched planner's submission is accepted
    // by `acceptSubmittedPlan` exactly like the first one's.
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('planning');
    // One session launched, for the new planner run.
    expect(h.starts).toHaveLength(1);
    const launch = h.starts[0] as { nodeRunId: number; graphEnv: Record<string, string> };
    expect(launch.nodeRunId).toBe(result.plannerRunId);
    expect(launch.graphEnv.KARST_GRAPH_CAPABILITY).toBeTruthy();
    expect(
      (h.starts[0] as { interactive: { initialPrompt: string } }).interactive.initialPrompt,
    ).toContain('node "$KARST_GRAPH_CLI" graph submit');
  });

  it('is a no-op for a run that already left planning', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(result.kind).toBe('no-op');
    expect(h.starts).toHaveLength(0);
    const planners = h.db.prepare('SELECT COUNT(*) AS n FROM approach_planner_runs').get() as {
      n: number;
    };
    expect(planners.n).toBe(0);
  });

  it('is a no-op for a missing graph run', async () => {
    const h = harness();
    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId: 999 });
    expect(result.kind).toBe('no-op');
    expect(h.starts).toHaveLength(0);
  });

  it('returns instructions-missing when the planner prompt cannot be read', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.deps.promptBytesOf = () => undefined;
    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(result.kind).toBe('instructions-missing');
    expect(h.starts).toHaveLength(0);
  });
});
