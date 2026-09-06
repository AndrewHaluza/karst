/**
 * The graph-run host driver — the missing launch seam, pinned end to end.
 *
 * These tests drive the driver's real orchestration against the in-memory
 * store with faked transport/prompts/git, so the graph approach's launch
 * path is exercised as the extension host will call it.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../store/db.js';
import { graphApproachConfig } from '../../manifest/fixtures.js';
import type { GraphApproachConfig } from '../../manifest/types.js';
import { SUPPORTED, unsupported } from '../../agent/surfaces.js';
import { domainKeyOf } from './integration/domains.js';
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
  readPlannerDiagnostics,
  diagnosticsPathFor,
  sha256Hex,
  nodeWorkspaceDirective,
} from './driver.js';
import type { SupervisedAgentSession, SupervisedLaunchRequest } from './transport/supervisedCliTransport.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { createGraphRun } from '../../store/graph/graphRuns.js';
import { createRevision } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';
import { SUPERVISED_CLI_TRANSPORT_CAPABILITIES } from './transport/supervisedCliTransport.js';

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
    surfaces: {
      exactModel: SUPPORTED,
    } as never,
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
    capabilities: () => SUPERVISED_CLI_TRANSPORT_CAPABILITIES,
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
    gitCommonDirOf: () => null,
    workspaceOf: () => undefined,
    createWorkspace: async () => ({ kind: 'created', paths: [{ repoName: 'api', cwd: join(root, 'ws'), domainKey: 'd' }] }),
    sessionNamingOf: (_graphRunId, runId, kind) => ({ name: `Karst ${kind} ${runId}` }),
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

  it('stamps started_at when the planner reaches running, so a stale planner is visible as one', async () => {
    const h = harness();
    const result = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      projectSlug: 'acme',
    });
    expect(result.kind).toBe('launched');
    if (result.kind !== 'launched') return;
    const planner = h.db
      .prepare('SELECT status, started_at FROM approach_planner_runs WHERE id = ?')
      .get(result.plannerRunId) as { status: string; started_at: string | null };
    expect(planner.status).toBe('running');
    expect(planner.started_at).toBe(h.deps.now());
  });

  it('names the legal repository, profile and command values in the planner prompt', async () => {
    const h = harness();
    await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      projectSlug: 'acme',
    });
    const prompt = (h.starts[0] as { interactive: { initialPrompt: string } }).interactive
      .initialPrompt;
    expect(prompt).toContain('## Legal values for this run');
    expect(prompt).toContain('repositories: `api`');
    expect(prompt).toContain('profiles: `expert`, `worker`');
    expect(prompt).toContain('commands: `test`');
  });

  it('says a run declares NO commands rather than listing an empty set', async () => {
    const h = harness();
    h.deps.compileContextOf = () => ({ ...compileContextOf(), commands: new Map() });
    await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      projectSlug: 'acme',
    });
    const prompt = (h.starts[0] as { interactive: { initialPrompt: string } }).interactive
      .initialPrompt;
    expect(prompt).toContain('commands: none — this run cannot use `command` nodes');
  });

  it('leaves a planner whose spawn threw at launching with its nonce — the shape reconcile relaunches', async () => {
    const h = harness();
    h.deps.transport.start = async () => {
      throw new Error('adapter misconfigured');
    };
    const result = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      projectSlug: 'acme',
    });
    expect(result.kind).toBe('failed');
    const planner = h.db
      .prepare('SELECT status, owner_nonce, process_run_id FROM approach_planner_runs ORDER BY id')
      .get() as { status: string; owner_nonce: string | null; process_run_id: number | null };
    // `running` with no process is the shape `reconcilePlanningPlanner`
    // deliberately never judges dead — it would strand the run forever.
    expect(planner.status).toBe('launching');
    expect(planner.owner_nonce).not.toBeNull();
    expect(planner.process_run_id).toBeNull();
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

  /** A planning run with a submitted bootstrap planner and a snapshot. */
  function submittedPlan(h: Harness, snapshotId: string, json: string): number {
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', ?, ?)`,
      )
      .run(graphRunId, snapshotId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, `${snapshotId}.json`), json);
    return graphRunId;
  }

  const INVALID_DOC = JSON.stringify({ version: 1, title: 'Bad', entries: [] });

  it('blocks the run with graph-plan-invalid once the compile attempts are exhausted', () => {
    const h = harness();
    const graphRunId = submittedPlan(h, 'fp2', INVALID_DOC);
    // Two attempts already consumed — this rejection is the last one.
    h.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 2 WHERE graph_run_id = ?').run(graphRunId);

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('rejected');
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('graph-plan-invalid');
    const planner = h.db
      .prepare('SELECT compile_attempt FROM approach_planner_runs WHERE graph_run_id = ?')
      .get(graphRunId) as { compile_attempt: number };
    expect(planner.compile_attempt).toBe(3);
  });

  it('G2: a first rejection re-prompts the SAME planner run instead of blocking', () => {
    const h = harness();
    const graphRunId = submittedPlan(h, 'fp2', INVALID_DOC);
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('repair-requested');
    if (result.kind !== 'repair-requested') return;
    expect(result.plannerRunId).toBe(plannerRunId);
    expect(result.attempt).toBe(1);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    // The run is NOT blocked — it stays planning for the re-prompt.
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('planning');
    expect(run.blocked_reason).toBeNull();
    // No NEW planner run is created; the durable counter is the same column
    // `compileWithRepair` keeps, and the planner is re-promptable (`blocked`).
    const planners = h.db
      .prepare('SELECT id, status, compile_attempt FROM approach_planner_runs WHERE graph_run_id = ?')
      .all(graphRunId) as { id: number; status: string; compile_attempt: number }[];
    expect(planners).toHaveLength(1);
    expect(planners[0]!.status).toBe('blocked');
    expect(planners[0]!.compile_attempt).toBe(1);
    // G3: the diagnostics are persisted where the re-prompt reads them.
    expect(readPlannerDiagnostics(h.deps, graphRunId, plannerRunId).length).toBeGreaterThan(0);
  });

  it('a lost submitted→blocked CAS leaves compile_attempt unchanged (never burns a budgeted attempt)', () => {
    const h = harness();
    const graphRunId = submittedPlan(h, 'fp2', INVALID_DOC);
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    // Simulate another window winning the race INSIDE rejectPlan's own
    // transaction attempt: the wrapped `transaction` moves the planner run out
    // of `submitted` immediately before the real transaction runs, so the
    // `submitted → blocked` CAS inside it is guaranteed to lose.
    const deps: Deps = {
      ...h.deps,
      transaction: <T>(fn: () => T): T => {
        h.db.prepare("UPDATE approach_planner_runs SET status = 'stale' WHERE id = ?").run(plannerRunId);
        return h.db.transaction(fn)();
      },
    };

    const result = acceptSubmittedPlan(deps, graphRunId);
    expect(result.kind).toBe('undecidable');
    const planner = h.db
      .prepare('SELECT status, compile_attempt FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; compile_attempt: number };
    // The CAS lost — the attempt counter must NOT have been consumed.
    expect(planner.compile_attempt).toBe(0);
    expect(planner.status).toBe('stale');
  });

  it('G1b: declines to judge a plan while the manifest is unresolved', () => {
    const h = harness();
    const graphRunId = submittedPlan(h, 'fp2', gateGraphJson());
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const deps: Deps = {
      ...h.deps,
      // The window's manifest has not resolved — every repository claim would
      // read `unknown-repository` against an empty map.
      manifestResolvedFor: () => ({ resolved: false, reason: 'manifest unresolved' }),
      compileContextOf: () => ({ ...compileContextOf(), repositories: new Map() }),
    };

    const result = acceptSubmittedPlan(deps, graphRunId);
    expect(result.kind).toBe('undecidable');
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('planning');
    expect(run.blocked_reason).toBeNull();
    // Nothing is consumed: no attempt, no diagnostics file, no planner move.
    const planner = h.db
      .prepare('SELECT status, compile_attempt FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; compile_attempt: number };
    expect(planner.status).toBe('submitted');
    expect(planner.compile_attempt).toBe(0);
    expect(readPlannerDiagnostics(h.deps, graphRunId, plannerRunId)).toEqual([]);
    // And the very same plan IS judged once the manifest resolves.
    expect(acceptSubmittedPlan(h.deps, graphRunId).kind).toBe('accepted');
  });

  it('G1b: a resolved manifest still rejects a plan claiming an unknown repository', () => {
    const h = harness();
    const graphRunId = submittedPlan(h, 'fp2', INVALID_DOC);
    h.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 2 WHERE graph_run_id = ?').run(graphRunId);
    const deps: Deps = { ...h.deps, manifestResolvedFor: () => ({ resolved: true }) };

    expect(acceptSubmittedPlan(deps, graphRunId).kind).toBe('rejected');
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

  it('repairs a planning run that already holds an active revision instead of inserting a second one', () => {
    // The corrupt state the activation sweep and the PR-sync sweep can both
    // drive at once: the run still reads `planning` while a prior accept
    // already committed an active revision (its `finishPlanning` transition
    // was lost). Accept must NOT throw the partial-unique-index UNIQUE
    // constraint on every sweep — it repairs the run status and reports the
    // existing revision.
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    // A submitted bootstrap planner whose snapshot the run already accepted.
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', 'fp1', ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'fp1.json'), gateGraphJson());
    // The already-accepted active revision (revision 1, in the past).
    createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: gateGraphJson(),
      fingerprint: 'fp-committed',
      status: 'active',
      now: NOW,
    });

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    // It reports the EXISTING revision, never a second active row.
    expect(result.revisionId).toBe(1);
    const count = h.db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_revisions WHERE graph_run_id = ? AND status = \'active\'')
      .get(graphRunId) as { n: number };
    expect(count.n).toBe(1);
    // And it repairs the run out of the stuck `planning` status.
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('awaiting-confirmation');
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

  it('names the isolated workspace in the node prompt so the agent never edits the canonical checkout', async () => {
    // The reported defect: the node's ticket context named the repository by
    // its CANONICAL path (`extention: /Users/nd/Work/projects/karst/`), and
    // the implementation agent trusted it — touching files in the MAIN
    // checkout via `../..` escapes instead of its isolated workspace. The
    // launch prompt must therefore state the workspace explicitly and forbid
    // escaping it.
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
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
          inputs: [],
          outputs: [],
          resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
    });
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: doc,
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, 'impl', 'agent', 1, 'ready')`,
        )
        .run(graphRunId, revisionId)
        .lastInsertRowid,
    );
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/task.md', sha256Hex(taskSnap), taskSnap.length, NOW);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.launched).toBe(1);
    const launch = h.starts[0] as {
      interactive: { initialPrompt: string };
      cwd: string;
    };
    const prompt = launch.interactive.initialPrompt;
    expect(prompt).toContain('## Node workspace');
    // The workspace the node session actually runs in — the isolated clone.
    expect(prompt).toContain(join(h.root, 'ws'));
    // The canonical worktree the clone came from — named, but marked NOT the
    // work target.
    expect(prompt).toContain(join(h.root, 'wt-api'));
    expect(prompt).toContain('CANONICAL locations, not where you work');
    expect(launch.cwd).toBe(join(h.root, 'ws'));
  });

  it('re-drives a retry-armed launching agent node with no owner nonce or process', async () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
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
          inputs: [],
          outputs: [],
          resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
    });
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: doc,
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs
             (graph_run_id, revision_id, node_id, node_kind, visit_number, status, launch_attempt, owner_nonce, process_run_id)
           VALUES (?, ?, 'impl', 'agent', 1, 'launching', 2, NULL, NULL)`,
        )
        .run(graphRunId, revisionId)
        .lastInsertRowid,
    );
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
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
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string };
    expect(node.status).toBe('running');
  });

  it('persists the owner nonce in the claim transaction — a launching row is never observable without launch identity', async () => {
    const h = harness();
    const observed: { nonce: string | null; request: string }[] = [];
    const baseStart = h.deps.transport.start;
    h.deps.transport.start = async (request) => {
      // What ANOTHER window's coordinator would see mid-launch: the row is
      // already `launching`, and its identity must already be durable — the
      // driver's launchable query and reconcile both read the absence of an
      // owner nonce as "provably never spawned".
      const row = h.db
        .prepare('SELECT status, owner_nonce FROM approach_node_runs WHERE id = ?')
        .get(request.nodeRunId) as { status: string; owner_nonce: string | null };
      expect(row.status).toBe('launching');
      observed.push({ nonce: row.owner_nonce, request: request.ownerNonce });
      return baseStart(request);
    };
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
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
          inputs: [],
          outputs: [],
          resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
    });
    const revisionId = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: doc,
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, 'impl', 'agent', 1, 'ready')`,
        )
        .run(graphRunId, revisionId)
        .lastInsertRowid,
    );
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/task.md', sha256Hex(taskSnap), taskSnap.length, NOW);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.launched).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.nonce).toBeTruthy();
    // The launch carries the SAME nonce the claim persisted — the transport
    // never mints a second identity for a row that already has one.
    expect(observed[0]!.request).toBe(observed[0]!.nonce);
    const node = h.db
      .prepare('SELECT owner_nonce FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { owner_nonce: string | null };
    expect(node.owner_nonce).toBe(observed[0]!.nonce);
  });

  it('releases the active process slot when launch parking blocks the node', async () => {
    const h = harness();
    h.deps.adapterFor = () =>
      ({
        ...fakeAdapter(),
        surfaces: {
          exactModel: unsupported(
            'this adapter cannot prevent model fallback or prove which model ran in the session',
          ),
        } as never,
      }) as AgentAdapter;
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
    h.db.prepare('UPDATE approach_graph_runs SET active_processes = 1 WHERE id = ?').run(graphRunId);
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
          inputs: [],
          outputs: [],
          resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
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
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/task.md', sha256Hex(taskSnap), taskSnap.length, NOW);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.blocked).toBe(1);
    const run = h.db
      .prepare('SELECT active_processes FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { active_processes: number };
    expect(run.active_processes).toBe(0);
  });

  it('does not report a launch when launching-to-running lost the CAS race', async () => {
    const h = harness();
    const baseStart = h.deps.transport.start;
    h.deps.transport.start = async (request) => {
      h.db.prepare("UPDATE approach_node_runs SET status = 'blocked' WHERE id = ?").run(request.nodeRunId);
      return baseStart(request);
    };
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
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
          inputs: [],
          outputs: [],
          resources: { reads: [{ repo: 'api', paths: ['src'] }], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
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
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/task.md', sha256Hex(taskSnap), taskSnap.length, NOW);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.launched).toBe(0);
    expect(result.blocked).toBe(1);
    const node = h.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string };
    expect(node.status).toBe('blocked');
  });

  it('matches base heads per physical domain and carries gitCommonDir into workspace creation', async () => {
    const h = harness();
    const deps = h.deps as typeof h.deps & { gitCommonDirOf?: (cwd: string) => string | null };
    const apiCwd = '/wt-api';
    const webCwd = '/wt-web';
    const apiCommon = '/git/api';
    const webCommon = '/git/web';
    const created: { domains: { repoName: string; gitCommonDir: string | null; baseCommit: string }[] }[] = [];
    deps.cwdForRepo = (_graphRunId, repo) => (repo === 'api' ? apiCwd : repo === 'web' ? webCwd : undefined);
    deps.gitCommonDirOf = (cwd) => (cwd === apiCwd ? apiCommon : cwd === webCwd ? webCommon : null);
    deps.createWorkspace = vi.fn(async (input) => {
      created.push({ domains: input.domains });
      return {
        kind: 'created' as const,
        paths: [{ repoName: 'api', cwd: join(h.root, 'ws'), domainKey: 'd-api' }],
      };
    });
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    runningGraphRun(h, graphRunId);
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
          inputs: [],
          outputs: [],
          resources: {
            reads: [
              { repo: 'api', paths: ['src/api'] },
              { repo: 'web', paths: ['src/web'] },
            ],
            writes: [{ repo: 'web', paths: ['src/web'] }],
          },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
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
          `INSERT INTO approach_node_runs
             (graph_run_id, revision_id, node_id, node_kind, visit_number, status, base_heads)
           VALUES (?, ?, 'impl', 'agent', 1, 'ready', ?)`,
        )
        .run(
          graphRunId,
          revisionId,
          JSON.stringify([
            { domainKey: domainKeyOf(apiCwd, apiCommon), commit: 'api-base' },
            { domainKey: domainKeyOf(webCwd, webCommon), commit: 'web-base' },
          ]),
        )
        .lastInsertRowid,
    );
    h.db
      .prepare('UPDATE approach_graph_tokens SET status = \'claimed\', claiming_node_run_id = ? WHERE id = ?')
      .run(nodeRunId, tokenId);
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const taskSnap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, ?, ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunId, 'artifacts/task.md', sha256Hex(taskSnap), taskSnap.length, NOW);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.launched).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.domains).toEqual([
      {
        repoName: 'api',
        canonicalWorktreePath: apiCwd,
        gitCommonDir: apiCommon,
        baseCommit: 'api-base',
      },
      {
        repoName: 'web',
        canonicalWorktreePath: webCwd,
        gitCommonDir: webCommon,
        baseCommit: 'web-base',
      },
    ]);
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

  it('G1b: declines to judge a replan while the manifest is unresolved', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    createRevision(h.db, {
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

    const deps: Deps = {
      ...h.deps,
      // Every repository claim would read `unknown-repository` against an
      // empty map — the replan must NOT be rejected for the window's state.
      manifestResolvedFor: () => ({ resolved: false, reason: 'manifest unresolved' }),
      compileContextOf: () => ({ ...compileContextOf(), repositories: new Map() }),
    };
    const result = acceptSubmittedReplan(deps, graphRunId);
    expect(result.kind).toBe('undecidable');
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('draining');
    // The very same replan IS judged once the manifest resolves.
    expect(acceptSubmittedReplan(h.deps, graphRunId).kind).toBe('accepted');
  });

  /** A draining run whose replan planner submitted `json`. */
  function submittedReplan(h: Harness, json: string): number {
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    createRevision(h.db, {
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
    writeFileSync(join(snapshotDir, 'rpl.json'), json);
    return graphRunId;
  }

  const INVALID_REPLAN = JSON.stringify({ version: 1, title: 'Bad', entries: [] });

  it('H1: a rejected replan re-prompts the SAME replan planner instead of stranding the drain', () => {
    const h = harness();
    const graphRunId = submittedReplan(h, INVALID_REPLAN);
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);

    const result = acceptSubmittedReplan(h.deps, graphRunId);
    expect(result.kind).toBe('repair-requested');
    if (result.kind !== 'repair-requested') return;
    expect(result.plannerRunId).toBe(plannerRunId);
    expect(result.attempt).toBe(1);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    // The run stays draining for the re-prompt; the planner is re-promptable.
    const run = h.db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string };
    expect(run.status).toBe('draining');
    const planner = h.db
      .prepare('SELECT status, compile_attempt FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; compile_attempt: number };
    expect(planner.status).toBe('blocked');
    expect(planner.compile_attempt).toBe(1);
    // The diagnostics land where the re-prompt reads them.
    expect(readPlannerDiagnostics(h.deps, graphRunId, plannerRunId).length).toBeGreaterThan(0);
  });

  it('H1: an exhausted replan repair blocks the run instead of draining forever', () => {
    const h = harness();
    const graphRunId = submittedReplan(h, INVALID_REPLAN);
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    h.db.prepare('UPDATE approach_planner_runs SET compile_attempt = 2 WHERE id = ?').run(plannerRunId);

    const result = acceptSubmittedReplan(h.deps, graphRunId);
    expect(result.kind).toBe('rejected');
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toContain('graph-plan-invalid');
    const planner = h.db
      .prepare('SELECT compile_attempt FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { compile_attempt: number };
    expect(planner.compile_attempt).toBe(3);
  });

  it('H1: an unreadable replan snapshot enters the same repair loop, never a silent no-op', () => {
    const h = harness();
    const graphRunId = submittedReplan(h, INVALID_REPLAN);
    rmSync(join(h.root, String(graphRunId), 'snapshots', 'rpl.json'));

    const result = acceptSubmittedReplan(h.deps, graphRunId);
    expect(result.kind).toBe('repair-requested');
    const planner = h.db
      .prepare("SELECT status FROM approach_planner_runs WHERE graph_run_id = ? AND kind = 'replan'")
      .get(graphRunId) as { status: string };
    expect(planner.status).toBe('blocked');
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

  it('leaves a replan planner whose spawn threw at launching with its nonce', async () => {
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
    h.deps.transport.start = async () => {
      throw new Error('adapter misconfigured');
    };
    const result = await launchReplanPlanner(h.deps, {
      graphRunId,
      plannerRunId,
      generation: '',
      capability: '',
      prompt: '# replan',
      cwd: join(h.root, 'wt'),
      repo: 'api',
    });
    expect(result.kind).toBe('failed');
    const planner = h.db
      .prepare('SELECT status, owner_nonce, process_run_id FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; owner_nonce: string | null; process_run_id: number | null };
    expect(planner.status).toBe('launching');
    expect(planner.owner_nonce).not.toBeNull();
    expect(planner.process_run_id).toBeNull();
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

  it('carries the prior planner run\'s compile diagnostics into the relaunch prompt', async () => {
    // A Resume out of `graph-plan-invalid` lands here. Without the rejection
    // the new planner replans from scratch and re-submits the same rejected
    // budgets — the loop the user sees as "resume repeats the same issue".
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    const priorPlannerRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
           VALUES (?, 1, 'bootstrap', 'blocked')`,
        )
        .run(graphRunId).lastInsertRowid,
    );
    h.deps.writeSnapshot(
      graphRunId,
      diagnosticsPathFor(priorPlannerRunId),
      new TextEncoder().encode(
        JSON.stringify(['expert-budget-exceeded: budgets.maxExpertRuns: expert budget 3 exceeds declared maxExpertRuns 1']),
      ),
    );

    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(result.kind).toBe('launched');
    const prompt = (h.starts[0] as { interactive: { initialPrompt: string } }).interactive
      .initialPrompt;
    expect(prompt).toContain('REJECTED');
    expect(prompt).toContain('expert-budget-exceeded');
  });

  it('leaves a relaunched planner whose spawn threw at launching with its nonce', async () => {
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
         VALUES (?, 1, 'bootstrap', 'stale')`,
      )
      .run(graphRunId);
    h.deps.transport.start = async () => {
      throw new Error('adapter misconfigured');
    };
    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(result.kind).toBe('failed');
    const planner = h.db
      .prepare(
        'SELECT status, owner_nonce, process_run_id FROM approach_planner_runs WHERE graph_run_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(graphRunId) as { status: string; owner_nonce: string | null; process_run_id: number | null };
    expect(planner.status).toBe('launching');
    expect(planner.owner_nonce).not.toBeNull();
    expect(planner.process_run_id).toBeNull();
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

describe('nodeWorkspaceDirective', () => {
  it('names the workspace and canonical worktree and forbids escaping the workspace', () => {
    const directive = nodeWorkspaceDirective({
      workspace: '/graph/369/8/workspaces/8/extention',
      canonicalWorktree: '/Users/nd/Work/projects/karst/.karst/worktrees/test-dynamic-graph-001',
      baseCommit: '6820a4b',
    });
    expect(directive).toContain('/graph/369/8/workspaces/8/extention');
    expect(directive).toContain('/Users/nd/Work/projects/karst/.karst/worktrees/test-dynamic-graph-001');
    expect(directive).toContain('6820a4b');
    expect(directive).toContain('CANONICAL locations, not where you work');
    expect(directive).toContain('never traverse out of it');
  });

  it('omits the base commit when none is known', () => {
    const directive = nodeWorkspaceDirective({
      workspace: '/ws/extention',
      canonicalWorktree: '/wt/extention',
      baseCommit: '',
    });
    expect(directive).toContain('Your workspace for this node is: `/ws/extention`');
    expect(directive).not.toContain(' at `');
  });
});
