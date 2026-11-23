/**
 * The graph-run host driver — the missing launch seam, pinned end to end.
 *
 * These tests drive the driver's real orchestration against the in-memory
 * store with faked transport/prompts/git, so the graph approach's launch
 * path is exercised as the extension host will call it.
 */

import { recoveryCategoryFor } from './coordinator/recovery.js';
import type { CreateNodeWorkspaceResult } from './workspace/provider.js';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../store/db.js';
import { graphApproachConfig, fullPreset, manifest, repo } from '../../manifest/fixtures.js';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import { SUPPORTED, unsupported } from '../../agent/surfaces.js';
import { domainKeyOf } from './integration/domains.js';
import type { CompileContext } from './compile.js';
import type { GraphDriverDeps, GraphDriverDeps as Deps } from './driver.js';
import {
  bootstrapAndLaunchPlanner,
  acceptSubmittedPlan,
  acceptSubmittedReplan,
  driveReadyNodeRuns,
  launchReplanPlanner,
  relaunchBootstrapPlanner,
  readPlannerDiagnostics,
  diagnosticsPathFor,
  sha256Hex,
  nodeWorkspaceDirective,
  resolveGraphNodeProfile,
  parkLaunchFailure,
  parkNodeLaunchExit,
  nodePromptWithReporter,
} from './driver.js';
import type { SupervisedAgentSession, SupervisedLaunchRequest } from './transport/supervisedCliTransport.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { createGraphRun } from '../../store/graph/graphRuns.js';
import { ticketLaunchFields } from './profileResolver.js';
import { acquireLease } from '../../store/graph/leases.js';
import { createRevision } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';
import { SUPERVISED_CLI_TRANSPORT_CAPABILITIES } from './transport/supervisedCliTransport.js';

import {
  NOW,
  gateGraphJson,
  compileContextOf,
  testManifest,
  fakeAdapter,
  harness,
  plannerRunIdFor,
  runningGraphRun,
  type Harness,
} from './driverHarness.js';

describe('bootstrapAndLaunchPlanner dependency preflight', () => {
  const input = (h: Harness) => ({
    ticketId: h.ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    projectSlug: 'acme',
  });

  it('writes the Karst output line and a graph diagnostic, and still launches', async () => {
    const h = harness();
    const lines: string[] = [];
    const result = await bootstrapAndLaunchPlanner(
      { ...h.deps, debug: (m) => void lines.push(m), depsPreflightOf: async () => 'deps: api not provided' },
      input(h),
    );
    expect(result.kind).toBe('launched');
    expect(lines.filter((l) => l.includes('deps: api not provided')).length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes('[graph] run') && l.includes('deps: api not provided'))).toBe(true);
    expect(h.starts).toHaveLength(1);
  });

  it('writes nothing when every repository gets its dependencies', async () => {
    const h = harness();
    const lines: string[] = [];
    await bootstrapAndLaunchPlanner(
      { ...h.deps, debug: (m) => void lines.push(m), depsPreflightOf: async () => undefined },
      input(h),
    );
    expect(lines.some((l) => l.includes('not provided'))).toBe(false);
  });

  it('launches even when the preflight throws', async () => {
    const h = harness();
    const lines: string[] = [];
    const result = await bootstrapAndLaunchPlanner(
      {
        ...h.deps,
        debug: (m) => void lines.push(m),
        depsPreflightOf: async () => {
          throw new Error('boom');
        },
      },
      input(h),
    );
    expect(result.kind).toBe('launched');
    expect(lines.some((l) => l.includes('dependency preflight failed'))).toBe(true);
  });
});

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
    expect(run.status).toBe('running');
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

  it('stamps the bootstrap planner run ended_at when it accepts the plan', () => {
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
    const planDir = join(h.root, String(graphRunId), 'artifacts');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), '# plan');

    expect(acceptSubmittedPlan(h.deps, graphRunId).kind).toBe('accepted');
    const planner = h.db
      .prepare('SELECT status, ended_at FROM approach_planner_runs WHERE graph_run_id = ?')
      .get(graphRunId) as { status: string; ended_at: string | null };
    expect(planner.status).toBe('submitted');
    expect(planner.ended_at).toBe(NOW);
  });

  it('numbers a recovery bootstrap revision monotonically past a surviving draining revision', () => {
    // The replan-park leaves revision #1 `draining`; a bootstrap relaunch then
    // re-accepts. A hardcoded revision number 1 would collide with the
    // UNIQUE (graph_run_id, revision_number) and throw on every tick.
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
    h.db.prepare("UPDATE approach_graph_runs SET status = 'planning' WHERE id = ?").run(graphRunId);
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', 'fp1', ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'fp1.json'), gateGraphJson());
    const planDir = join(h.root, String(graphRunId), 'artifacts');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), '# plan');

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.revisionNumber).toBe(2);
    // The abandoned drain is superseded, so never two live `draining`
    // revisions — otherwise the drain selectors disagree and strand the next
    // replan.
    const revisions = h.db
      .prepare(
        'SELECT revision_number, status FROM approach_graph_revisions WHERE graph_run_id = ? ORDER BY revision_number',
      )
      .all(graphRunId);
    expect(revisions).toEqual([
      { revision_number: 1, status: 'superseded' },
      { revision_number: 2, status: 'active' },
    ]);
  });

  it('cancels the abandoned drain’s blocked requester node when bootstrap recovery supersedes it', () => {
    // Left `blocked`, the requester (and its held lease) blocks the recovered
    // revision's END quiescence run-wide — the run reads as faulted immediately.
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    const rev1 = createRevision(h.db, {
      graphRunId,
      revisionNumber: 1,
      canonicalGraph: '{}',
      fingerprint: 'old',
      status: 'draining',
      now: NOW,
    });
    h.db
      .prepare(
        `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status, outcome)
         VALUES (?, ?, 'a', 'agent', 1, 'blocked', 'replan')`,
      )
      .run(graphRunId, rev1);
    h.db.prepare("UPDATE approach_graph_runs SET status = 'planning' WHERE id = ?").run(graphRunId);
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, submitted_at)
         VALUES (?, 1, 'bootstrap', 'submitted', 'fp1', ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'fp1.json'), gateGraphJson());
    const planDir = join(h.root, String(graphRunId), 'artifacts');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), '# plan');

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('accepted');
    const requester = h.db
      .prepare('SELECT status, outcome FROM approach_node_runs WHERE revision_id = ?')
      .get(rev1) as { status: string; outcome: string | null };
    expect(requester).toEqual({ status: 'cancelled', outcome: 'replan' });
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

  it('marks a late submitted bootstrap planner run stale when run is not in planning', () => {
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
    const plannerRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id)
           VALUES (?, 1, 'bootstrap', 'submitted', 'snap-1')`,
        )
        .run(graphRunId).lastInsertRowid,
    );
    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('no-op');
    const planner = h.db
      .prepare('SELECT status, reason, ended_at FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; reason: string | null; ended_at: string | null };
    expect(planner.status).toBe('stale');
    expect(planner.reason).toBe('submitted into running run');
    expect(planner.ended_at).not.toBeNull();
  });

  it('does not mark an already accepted bootstrap planner run stale', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    const plannerRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id)
           VALUES (?, 1, 'bootstrap', 'submitted', 'snap-accepted')`,
        )
        .run(graphRunId).lastInsertRowid,
    );
    h.db
      .prepare(
        `INSERT INTO approach_graph_revisions (graph_run_id, revision_number, canonical_graph, fingerprint, planner_artifact_snapshot_id, status, created_at)
         VALUES (?, 1, '{}', 'fp-1', 'snap-accepted', 'active', ?)`,
      )
      .run(graphRunId, NOW);
    h.db
      .prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = ?")
      .run(graphRunId);

    const result = acceptSubmittedPlan(h.deps, graphRunId);
    expect(result.kind).toBe('no-op');
    const planner = h.db
      .prepare('SELECT status, reason, ended_at FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; reason: string | null; ended_at: string | null };
    expect(planner.status).toBe('submitted');
    expect(planner.reason).toBeNull();
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
    expect(run.status).toBe('running');
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

  it('releases the held domain lease of a command node when it completes', async () => {
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

    acquireLease(h.db, {
      graphRunId,
      ownerNodeRunId: nodeRunId,
      physicalDomain: 'domain-api',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    await driveReadyNodeRuns(h.deps, graphRunId);
    const leases = h.db
      .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ?')
      .all(nodeRunId) as Array<{ status: string }>;
    expect(leases).toEqual([{ status: 'released' }]);
  });

  it('leaves an ambiguous-process lease of a command node alone on completion', async () => {
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

    acquireLease(h.db, {
      graphRunId,
      ownerNodeRunId: nodeRunId,
      physicalDomain: 'domain-api',
      accessMode: 'write',
      claimedPaths: null,
      now: NOW,
    });
    h.db
      .prepare("UPDATE approach_resource_leases SET status = 'ambiguous-process' WHERE owner_node_run_id = ?")
      .run(nodeRunId);
    await driveReadyNodeRuns(h.deps, graphRunId);
    const lease = h.db
      .prepare('SELECT status FROM approach_resource_leases WHERE owner_node_run_id = ?')
      .get(nodeRunId) as { status: string };
    expect(lease.status).toBe('ambiguous-process');
    const node = h.db.prepare('SELECT status FROM approach_node_runs WHERE id = ?').get(nodeRunId) as {
      status: string;
    };
    expect(node.status).toBe('completed');
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

    // The launch itself does NOT clear a prior streak: `launching → running` is
    // written as soon as the provider spawns, before the transport learns
    // whether it survives its launch window. Clearing here is what made the
    // launch-loop guard unreachable. The streak survives the spawn and is only
    // ended by a park that proves this was not a launch exit.
    h.db.prepare('UPDATE approach_node_runs SET launch_fail_streak = 2 WHERE id = ?').run(nodeRunId);

    const result = await driveReadyNodeRuns(h.deps, graphRunId);
    expect(result.launched).toBe(1);
    const node = h.db
      .prepare(
        'SELECT status, generation, capability_hash, launch_fail_streak FROM approach_node_runs WHERE id = ?',
      )
      .get(nodeRunId) as {
      status: string;
      generation: string | null;
      capability_hash: string | null;
      launch_fail_streak: number;
    };
    expect(node.status).toBe('running');
    expect(node.launch_fail_streak).toBe(2);
    expect(node.generation).not.toBeNull();
    expect(node.capability_hash).not.toBeNull();
    const launch = h.starts[0] as { nodeRunId: number; graphEnv: Record<string, string> };
    expect(launch.nodeRunId).toBe(nodeRunId);
    expect(launch.graphEnv.KARST_GRAPH_CAPABILITY).toBeTruthy();
    // The identity is on the request AND on the row, written with the CAS.
    const identity = (h.starts[0] as { identity?: { profile: string; provider: string } }).identity;
    expect(identity).toMatchObject({ profile: 'worker' });
    const recorded = h.db
      .prepare('SELECT profile, provider, model, effort FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { profile: string; provider: string };
    expect(recorded.profile).toBe('worker');
    expect(recorded.provider).toBe(identity?.provider);
    expect(recorded.provider).toBeTruthy();
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

  it('stamps started_at in the claim transaction, so a launching row already has its start time', async () => {
    const h = harness();
    const seen: (string | null)[] = [];
    const baseStart = h.deps.transport.start;
    h.deps.transport.start = async (request) => {
      const row = h.db
        .prepare('SELECT started_at FROM approach_node_runs WHERE id = ?')
        .get(request.nodeRunId) as { started_at: string | null };
      seen.push(row.started_at);
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
    expect(seen).toEqual([NOW]);
    const node = h.db
      .prepare('SELECT started_at FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { started_at: string | null };
    expect(node.started_at).toBe(NOW);
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

  async function launchTwoRepoNode(
    outcome?: CreateNodeWorkspaceResult,
    opts: { skipDrive?: boolean; workspaceGate?: Promise<void>; rearmed?: boolean } = {},
  ) {
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
      if (opts.workspaceGate) await opts.workspaceGate;
      return (
        outcome ?? {
          kind: 'created' as const,
          paths: [{ repoName: 'api', cwd: join(h.root, 'ws'), domainKey: 'd-api' }],
          restored: false,
        }
      );
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

    if (opts.rearmed) {
      h.db.prepare("UPDATE approach_node_runs SET status = 'launching' WHERE id = ?").run(nodeRunId);
    }
    const result = opts.skipDrive
      ? { launched: 0, completed: 0, blocked: 0 }
      : await driveReadyNodeRuns(h.deps, graphRunId);
    return { h, graphRunId, nodeRunId, result, created, apiCwd, apiCommon, webCwd, webCommon };
  }

  it('matches base heads per physical domain and carries gitCommonDir into workspace creation', async () => {
    const { result, created, apiCwd, apiCommon, webCwd, webCommon } = await launchTwoRepoNode();
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

  it('parks a workspace dependency failure as graph-workspace-deps, not failed-to-launch', async () => {
    const { h, graphRunId, nodeRunId, result } = await launchTwoRepoNode({
      kind: 'deps-failed',
      reason: 'api: node_modules does not match package-lock.json: invalid: a@1.0.0',
    });
    expect(result.blocked).toBe(1);
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toBe(
      `graph-workspace-deps: node run ${nodeRunId} (api: node_modules does not match package-lock.json: invalid: a@1.0.0)`,
    );
    expect(recoveryCategoryFor(run.blocked_reason)).toBe('config-then-resume');
    const node = h.db
      .prepare('SELECT failure_category FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { failure_category: string };
    expect(node.failure_category).toBe('failed-to-launch');
  });

  it('parks a workspace budget stop as graph-budget-exhausted', async () => {
    const { h, graphRunId, nodeRunId } = await launchTwoRepoNode({
      kind: 'budget-exhausted',
      currentBytes: 10,
      estimatedBytes: 5,
      limitBytes: 12,
    });
    const run = h.db
      .prepare('SELECT blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { blocked_reason: string };
    expect(run.blocked_reason).toBe(`graph-budget-exhausted: node run ${nodeRunId} (15 bytes over the 12 workspace ceiling)`);
    expect(recoveryCategoryFor(run.blocked_reason)).toBe('config-then-resume');
  });

  it('parks a live-process refusal with its own graph-live-process reason', async () => {
    const { h, graphRunId, nodeRunId } = await launchTwoRepoNode({ kind: 'live-process', reason: 'pid 1' });
    const run = h.db
      .prepare('SELECT blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { blocked_reason: string };
    expect(run.blocked_reason).toBe(`graph-live-process: node run ${nodeRunId}`);
  });

  it('parks a failed preserve as graph-preserve-failed, never automatically retried', async () => {
    const { h, graphRunId, nodeRunId } = await launchTwoRepoNode({
      kind: 'preserve-failed',
      reason: 'disk full',
    });
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toBe(`graph-preserve-failed: node run ${nodeRunId} (disk full)`);
    expect(recoveryCategoryFor(run.blocked_reason)).toBe('config-then-resume');
    const node = h.db
      .prepare('SELECT failure_category FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { failure_category: string };
    expect(node.failure_category).toBe('failed-to-launch');
  });
  describe('claim before workspace', () => {
    function gate(): { promise: Promise<void>; open: () => void } {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }
    const nodeRow = (h: Harness, id: number) =>
      h.db
        .prepare('SELECT status, owner_nonce, started_at, reason FROM approach_node_runs WHERE id = ?')
        .get(id) as { status: string; owner_nonce: string | null; started_at: string | null; reason: string | null };

    it.each([false, true])(
      'two concurrent drives of one node run (rearmed=%s) create one workspace and launch once',
      async (rearmed) => {
        const g = gate();
        const { h, graphRunId, nodeRunId, created } = await launchTwoRepoNode(undefined, {
          skipDrive: true,
          workspaceGate: g.promise,
          rearmed,
        });
        const first = driveReadyNodeRuns(h.deps, graphRunId);
        // The second drive starts while the first awaits the slow clone.
        const second = driveReadyNodeRuns(h.deps, graphRunId);
        await Promise.resolve();
        expect(created).toHaveLength(1);
        g.open();
        const results = await Promise.all([first, second]);
        expect(created).toHaveLength(1);
        expect(h.starts).toHaveLength(1);
        expect(results.reduce((n, r) => n + r.launched, 0)).toBe(1);
        expect(nodeRow(h, nodeRunId).status).toBe('running');
        const run = h.db
          .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
          .get(graphRunId) as { status: string };
        expect(run.status).toBe('running');
      },
    );

    it('the claim is committed before the workspace is created', async () => {
      const g = gate();
      const { h, graphRunId, nodeRunId } = await launchTwoRepoNode(undefined, {
        skipDrive: true,
        workspaceGate: g.promise,
      });
      const drive = driveReadyNodeRuns(h.deps, graphRunId);
      await Promise.resolve();
      const mid = nodeRow(h, nodeRunId);
      expect(mid.status).toBe('launching');
      expect(mid.owner_nonce).not.toBeNull();
      expect(mid.started_at).not.toBeNull();
      g.open();
      await drive;
    });

    it('a lost launching→running CAS stops the spawned process tree, closes its tab and leaves the row alone', async () => {
      const { h, graphRunId, nodeRunId } = await launchTwoRepoNode(undefined, { skipDrive: true });
      const dispose = vi.fn();
      const terminate = vi.fn(async () => ({ kind: 'attributable', kill: 'killed' }) as const);
      const debug = vi.fn();
      h.deps.debug = debug;
      h.deps.transport.terminate = terminate;
      h.deps.transport.start = async (request) => {
        h.starts.push(request as unknown as Record<string, unknown>);
        // Another window parks the row while this drive spawns.
        h.db.prepare("UPDATE approach_node_runs SET status = 'blocked', reason = 'other' WHERE id = ?").run(request.nodeRunId);
        return {
          ticketId: h.ticketId, nodeRunId: request.nodeRunId, graphRunId: request.graphRunId,
          cwd: request.cwd, pid: 4242, startedAt: NOW, processRunId: null, providerSessionId: null,
          terminal: { dispose },
        } as unknown as Awaited<ReturnType<Deps['transport']['start']>>;
      };
      const result = await driveReadyNodeRuns(h.deps, graphRunId);
      expect(result.launched).toBe(0);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(nodeRow(h, nodeRunId)).toMatchObject({ status: 'blocked', reason: 'other' });
      expect(debug.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(new RegExp(`node run ${nodeRunId}.*pid 4242`));
    });

    it('a failed stop after a lost CAS is logged, never swallowed', async () => {
      const { h, graphRunId, nodeRunId } = await launchTwoRepoNode(undefined, { skipDrive: true });
      const debug = vi.fn();
      h.deps.debug = debug;
      h.deps.transport.terminate = async () => {
        throw new Error('boom');
      };
      h.deps.transport.start = async (request) => {
        h.db.prepare("UPDATE approach_node_runs SET status = 'blocked' WHERE id = ?").run(request.nodeRunId);
        return {
          ticketId: h.ticketId, nodeRunId: request.nodeRunId, graphRunId: request.graphRunId,
          cwd: request.cwd, pid: 4243, startedAt: NOW, processRunId: null, providerSessionId: null,
        } as unknown as Awaited<ReturnType<Deps['transport']['start']>>;
      };
      const result = await driveReadyNodeRuns(h.deps, graphRunId);
      expect(result.launched).toBe(0);
      expect(debug.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/WARN.*node run .*stopping.*boom/);
      expect(nodeRow(h, nodeRunId).status).toBe('blocked');
    });

    it('a workspace budget stop after the claim parks the node from launching', async () => {
      const { h, nodeRunId } = await launchTwoRepoNode({
        kind: 'budget-exhausted',
        currentBytes: 10,
        estimatedBytes: 5,
        limitBytes: 12,
      });
      expect(nodeRow(h, nodeRunId).status).toBe('blocked');
    });
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
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, target_revision_number, submitted_at)
         VALUES (?, 2, 'replan', 'submitted', 'rpl', 2, ?)`,
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

  it('accepts the CURRENT drain\u2019s replan, never a prior drain\u2019s still-submitted planner', () => {
    // A completed replan's planner stays `submitted` forever. An unscoped
    // `ORDER BY id LIMIT 1` lookup resolves to it and lands its stale document
    // as the next revision. The accept must be scoped to the draining
    // revision's successor: here revision 2 drains, so target 3.
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    createRevision(h.db, {
      graphRunId,
      revisionNumber: 2,
      canonicalGraph: '{}',
      fingerprint: 'old',
      status: 'draining',
      now: NOW,
    });
    h.db.prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?").run(graphRunId);
    // Prior drain's planner (target 2) is still submitted and points at a
    // missing snapshot; the current drain's planner (target 3) has the real one.
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, target_revision_number, submitted_at)
         VALUES (?, 2, 'replan', 'submitted', 'stale-rpl', 2, ?)`,
      )
      .run(graphRunId, NOW);
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, target_revision_number, submitted_at)
         VALUES (?, 3, 'replan', 'submitted', 'rpl', 3, ?)`,
      )
      .run(graphRunId, NOW);
    const snapshotDir = join(h.root, String(graphRunId), 'snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'rpl.json'), gateGraphJson());
    // 'stale-rpl.json' is deliberately absent — accepting it would reject.

    const result = acceptSubmittedReplan(h.deps, graphRunId);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.revisionNumber).toBe(3);
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
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, target_revision_number, submitted_at)
         VALUES (?, 2, 'replan', 'submitted', 'rpl', 2, ?)`,
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

  it('marks a late submitted replan planner run stale when run is not in draining', () => {
    const h = harness();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    h.db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = ?").run(graphRunId);
    const plannerRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id)
           VALUES (?, 2, 'replan', 'submitted', 'snap-rpl')`,
        )
        .run(graphRunId).lastInsertRowid,
    );
    const result = acceptSubmittedReplan(h.deps, graphRunId);
    expect(result.kind).toBe('no-op');
    const planner = h.db
      .prepare('SELECT status, reason, ended_at FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string; reason: string | null; ended_at: string | null };
    expect(planner.status).toBe('stale');
    expect(planner.reason).toBe('submitted into running run');
    expect(planner.ended_at).toBe(NOW);
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
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, graph_snapshot_id, target_revision_number, submitted_at)
         VALUES (?, 2, 'replan', 'submitted', 'rpl', 2, ?)`,
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

  it('unlinks stale graph.json at the artifact root before launching', async () => {
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
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(artRoot, { recursive: true });
    const stalePlan = join(artRoot, 'graph.json');
    writeFileSync(stalePlan, '{"stale": true}');

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
    expect(existsSync(stalePlan)).toBe(false);
  });

  it('preserves graph.json when isRepair is true', async () => {
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
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(artRoot, { recursive: true });
    const repairPlan = join(artRoot, 'graph.json');
    writeFileSync(repairPlan, '{"repair": true}');

    const result = await launchReplanPlanner(h.deps, {
      graphRunId,
      plannerRunId,
      generation: '',
      capability: '',
      prompt: '# compile repair',
      cwd: join(h.root, 'wt'),
      repo: 'api',
      isRepair: true,
    });
    expect(result.kind).toBe('launched');
    expect(existsSync(repairPlan)).toBe(true);
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

describe('resolveGraphNodeProfile', () => {
  const config = graphApproachConfig({
    profiles: {
      expert: { provider: 'opencode', model: 'mimo-2.5' },
      worker: { provider: 'claude', model: 'claude-opus-5' },
      fast: { provider: 'codex', model: 'gpt-5.6' },
      custom: { provider: 'antigravity', model: 'custom-model' },
    },
  });

  it('resolves graphExpert profile from preset slot when present', () => {
    const m = testManifest({
      agentPresets: {
        active: {
          label: 'Custom',
          slots: {
            graphExpert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
          },
        },
      },
      defaultAgentPreset: 'active',
    });
    const result = resolveGraphNodeProfile(m, config, 'expert');
    expect(result).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high', source: 'preset' });
  });

  it('resolves graphWorker profile from preset slot when present', () => {
    const m = testManifest({
      agentPresets: {
        active: {
          label: 'Custom',
          slots: {
            graphWorker: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
          },
        },
      },
      defaultAgentPreset: 'active',
    });
    const result = resolveGraphNodeProfile(m, config, 'worker');
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', source: 'preset' });
  });

  it('resolves graphFast profile from preset slot when present', () => {
    const m = testManifest({
      agentPresets: {
        active: {
          label: 'Custom',
          slots: {
            graphFast: { provider: 'opencode', model: 'mimo-2.5', effort: 'flash' },
          },
        },
      },
      defaultAgentPreset: 'active',
    });
    const result = resolveGraphNodeProfile(m, config, 'fast');
    // The effort gate removes `flash`: the model does not advertise it.
    expect(result).toEqual({ provider: 'opencode', model: 'mimo-2.5', source: 'preset' });
  });

  it('falls back to config profile when no preset slot', () => {
    const m = testManifest();
    const result = resolveGraphNodeProfile(m, config, 'expert');
    expect(result).toEqual({ provider: 'opencode', model: 'mimo-2.5', source: 'approach' });
  });

  it('resolves custom profile from config only (not preset-capable)', () => {
    const m = testManifest();
    const result = resolveGraphNodeProfile(m, config, 'custom');
    expect(result).toEqual({ provider: 'antigravity', model: 'custom-model', source: 'approach' });
  });

  it('returns undefined for missing profile', () => {
    const m = testManifest();
    const result = resolveGraphNodeProfile(m, config, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('calls onDebug callback for preset slot resolution', () => {
    const m = testManifest({
      agentPresets: {
        active: {
          label: 'Custom',
          slots: {
            graphExpert: { provider: 'claude', model: 'claude-opus-5' },
          },
        },
      },
      defaultAgentPreset: 'active',
    });
    const debugSpy = vi.fn();
    resolveGraphNodeProfile(m, config, 'expert', undefined, debugSpy);
    expect(debugSpy).toHaveBeenCalledWith(
      '[process] graph node profile "expert" → preset slot (claude)',
    );
  });

  it('calls onDebug callback for config profile resolution', () => {
    const m = testManifest();
    const debugSpy = vi.fn();
    resolveGraphNodeProfile(m, config, 'worker', undefined, debugSpy);
    expect(debugSpy).toHaveBeenCalledWith(
      '[process] graph node profile "worker" → config (claude/claude-opus-5)',
    );
  });

  it('prefers preset slot over config profile', () => {
    const m = testManifest({
      agentPresets: {
        active: {
          label: 'Custom',
          slots: {
            graphExpert: { provider: 'codex', model: 'gpt-custom' },
          },
        },
      },
      defaultAgentPreset: 'active',
    });
    const result = resolveGraphNodeProfile(m, config, 'expert');
    expect(result?.provider).toBe('codex');
    expect(result?.model).toBe('gpt-custom');
  });
});

describe('driveReadyNodeRuns — graph ticket mailbox and bulletin', () => {
  /** One single-node (impl → END) run, its node run `ready`, ready to launch. */
  function readyImpl(h: Harness, revisionStatus: 'active' | 'draining' | 'superseded' = 'active'): number {
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
        { id: 'task', path: 'artifacts/task.md', producer: '$planner', consumers: ['impl'], mediaType: 'text/markdown', maxBytes: 1000, required: true },
      ],
      nodes: [
        {
          id: 'impl', kind: 'agent', label: 'Implement', profile: 'worker', instructionsArtifact: 'task',
          inputs: [], outputs: [], resources: { reads: [], writes: [{ repo: 'api', paths: ['src/api'] }] },
          outcomes: ['complete', 'blocked'], budget: { maxVisits: 1 },
        },
      ],
      edges: [
        { id: 'e1', from: 'impl', on: 'complete', to: 'END' },
        { id: 'e2', from: 'impl', on: 'blocked', to: 'END' },
      ],
    });
    const revisionId = createRevision(h.db, {
      graphRunId, revisionNumber: 1, canonicalGraph: doc, fingerprint: 'fp', status: revisionStatus, now: NOW,
    });
    const [tokenId] = insertEntryTokens(
      h.db, revisionId, [{ edgeId: 'entry-impl', destinationNodeId: 'impl', destinationEnd: false }], NOW,
    );
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
           VALUES (?, ?, 'impl', 'agent', 1, 'ready')`,
        )
        .run(graphRunId, revisionId).lastInsertRowid,
    );
    h.db
      .prepare("UPDATE approach_graph_tokens SET status = 'claimed', claiming_node_run_id = ? WHERE id = ?")
      .run(nodeRunId, tokenId);
    const artRoot = h.deps.artifactRootOf(graphRunId);
    mkdirSync(join(artRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(artRoot, 'artifacts', 'task.md'), '# task');
    const snap = h.deps.readBytes(graphRunId, 'artifacts/task.md')!;
    h.db
      .prepare(
        `INSERT INTO approach_artifact_instances
           (graph_run_id, revision_id, artifact_id, producer_planner_run_id, snapshot_path, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'task', ?, 'artifacts/task.md', ?, 'text/markdown', ?, ?)`,
      )
      .run(graphRunId, revisionId, plannerRunIdFor(h.db, graphRunId), sha256Hex(snap), snap.length, NOW);
    return graphRunId;
  }

  /** Pending state read from the unread rows themselves, as the host binding does. */
  function withMailbox(h: Harness): void {
    h.deps.visitMailboxOf = (ticketId) => ({
      unreadMail: (
        h.db
          .prepare('SELECT COUNT(*) AS n FROM ticket_messages WHERE to_ticket_id = ? AND read_at IS NULL')
          .get(ticketId) as { n: number }
      ).n,
      unreadNotes: 0,
      noteTitles: [],
    });
  }

  const promptOf = (h: Harness): string =>
    (h.starts[0] as { interactive: { initialPrompt: string } }).interactive.initialPrompt;

  const sendMail = (h: Harness): void => {
    h.db
      .prepare("INSERT INTO ticket_messages (to_ticket_id, kind, body) VALUES (?, 'message', 'hi')")
      .run(h.ticketId);
  };

  it('puts the pending pointer in the next visit brief, from the unread rows (survives a reload)', async () => {
    const h = harness();
    withMailbox(h);
    sendMail(h);
    const graphRunId = readyImpl(h);
    // A reload rebuilds the deps; the pointer is re-derived from the same rows.
    withMailbox(h);
    await driveReadyNodeRuns(h.deps, graphRunId);
    expect(promptOf(h)).toContain('1 unread message — run `karst inbox`');
  });

  it('adds no pointer when no mail or notes are pending', async () => {
    const h = harness();
    withMailbox(h);
    const graphRunId = readyImpl(h);
    await driveReadyNodeRuns(h.deps, graphRunId);
    expect(promptOf(h)).not.toContain('karst inbox');
  });

  it('asks the completing visit (decided at visit time) for a note', async () => {
    const h = harness();
    withMailbox(h);
    const graphRunId = readyImpl(h);
    await driveReadyNodeRuns(h.deps, graphRunId);
    expect(promptOf(h)).toContain('karst notes post');
  });

  it('does not ask a visit that has another active node run for a note', async () => {
    const h = harness();
    withMailbox(h);
    const graphRunId = readyImpl(h);
    const revisionId = (
      h.db.prepare('SELECT id FROM approach_graph_revisions WHERE graph_run_id = ?').get(graphRunId) as { id: number }
    ).id;
    h.db
      .prepare(
        `INSERT INTO approach_node_runs (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (?, ?, 'other', 'agent', 1, 'running')`,
      )
      .run(graphRunId, revisionId);
    await driveReadyNodeRuns(h.deps, graphRunId);
    expect(promptOf(h)).not.toContain('karst notes post');
  });

  it.each(['draining', 'superseded'] as const)('injects nothing into a %s revision', async (status) => {
    const h = harness();
    withMailbox(h);
    sendMail(h);
    const graphRunId = readyImpl(h, status);
    await driveReadyNodeRuns(h.deps, graphRunId);
    expect(promptOf(h)).not.toContain('karst inbox');
    expect(promptOf(h)).not.toContain('karst notes post');
  });
});

describe('parkNodeLaunchExit', () => {
  /** A `running` graph with one agent node run the driver already moved to
   *  `running` — the state a provider that exited moments after spawn leaves.
   *  `launchFailStreak` is the CONSECUTIVE launch-failure count; `launchAttempt`
   *  counts every retry, whatever its cause. */
  function graphWithRunningNode(
    h: Harness,
    launchFailStreak: number,
    launchAttempt = 0,
  ): { graphRunId: number; nodeRunId: number } {
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
      canonicalGraph: '{}',
      fingerprint: 'fp',
      status: 'active',
      now: NOW,
    });
    const nodeRunId = Number(
      h.db
        .prepare(
          `INSERT INTO approach_node_runs
             (graph_run_id, revision_id, node_id, node_kind, visit_number, status, launch_attempt, launch_fail_streak)
           VALUES (?, ?, 'n', 'agent', 1, 'running', ?, ?)`,
        )
        .run(graphRunId, revisionId, launchAttempt, launchFailStreak)
        .lastInsertRowid,
    );
    return { graphRunId, nodeRunId };
  }

  function nodeOf(h: Harness, nodeRunId: number): {
    status: string;
    failure_category: string | null;
    reason: string | null;
    launch_fail_streak: number;
  } {
    return h.db
      .prepare(
        'SELECT status, failure_category, reason, launch_fail_streak FROM approach_node_runs WHERE id = ?',
      )
      .get(nodeRunId) as {
      status: string;
      failure_category: string | null;
      reason: string | null;
      launch_fail_streak: number;
    };
  }

  it('parks a node already `running` as failed-to-launch with the captured line', () => {
    const h = harness();
    const { graphRunId, nodeRunId } = graphWithRunningNode(h, 0);
    parkNodeLaunchExit(h.deps, graphRunId, nodeRunId, 'Folder trust required');

    const node = nodeOf(h, nodeRunId);
    expect(node.status).toBe('blocked');
    expect(node.failure_category).toBe('failed-to-launch');
    expect(node.reason).toBe('failed-to-launch: Folder trust required');
    // The park opened a run of one launch failure — the guard's streak.
    expect(node.launch_fail_streak).toBe(1);
    const run = h.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(graphRunId) as { status: string; blocked_reason: string | null };
    expect(run.status).toBe('blocked');
    expect(run.blocked_reason).toBe(`failed-to-launch: node run ${nodeRunId}`);
  });

  it('names the loop on the second launch failure of the same reserved visit', () => {
    const h = harness();
    const { graphRunId, nodeRunId } = graphWithRunningNode(h, 1);
    // Untrusted terminal text: collapsed to one line, controls stripped.
    parkNodeLaunchExit(h.deps, graphRunId, nodeRunId, '\u0000trust\n  this   folder?  ');

    const node = nodeOf(h, nodeRunId);
    expect(node.status).toBe('blocked');
    expect(node.failure_category).toBe('failed-to-launch');
    expect(node.reason).toContain('launched twice and exited before starting: trust this folder?');
    expect(node.reason).toContain('folder trust');
    expect(node.launch_fail_streak).toBe(2);
  });

  it('does not name the loop on a first launch failure even after earlier retries', () => {
    // The medium review finding: `launch_attempt` counts EVERY retry (here
    // two, from a session death), so keying the message off it fired the loop
    // text on a FIRST launch failure. The consecutive counter is 0, so this is
    // a first failure whatever the retry history.
    const h = harness();
    const { graphRunId, nodeRunId } = graphWithRunningNode(h, 0, 2);
    parkNodeLaunchExit(h.deps, graphRunId, nodeRunId, 'Folder trust required');
    expect(nodeOf(h, nodeRunId).reason).toBe('failed-to-launch: Folder trust required');
  });

  it('records no line when the host captured none', () => {
    const h = harness();
    const { graphRunId, nodeRunId } = graphWithRunningNode(h, 0);
    parkNodeLaunchExit(h.deps, graphRunId, nodeRunId, '');
    expect(nodeOf(h, nodeRunId).reason).toBe('failed-to-launch');
  });

  it('never parks a node run that belongs to another graph run', () => {
    // A planner's run id and a node run id are independent sequences, so a
    // mis-routed id can name a REAL node run that merely shares the number.
    // The park is scoped to (id, graph_run_id): a foreign run is untouched.
    const h = harness();
    const { nodeRunId } = graphWithRunningNode(h, 0);
    const otherRunId = createGraphRun(h.db, {
      ticketId: h.ticketId,
      stageAttempt: 1,
      approachId: 'karst-graph-engineering',
      now: NOW,
    });
    parkNodeLaunchExit(h.deps, otherRunId, nodeRunId, 'Folder trust required');
    // The foreign node keeps its `running` state and no failure line.
    expect(nodeOf(h, nodeRunId).status).toBe('running');
    expect(nodeOf(h, nodeRunId).reason).toBeNull();
  });

  it('does not advance the loop counter for a park that is not a provider exit', () => {
    // The medium review finding: a red-blocked node and an unresolved
    // workspace park `failed-to-launch` through the same `parkLaunchFailure`,
    // but they are NOT the folder-trust loop — only the provider early exit
    // (see `parkNodeLaunchExit`) may count. Such a park also ENDS a prior run
    // of provider exits: its failure proves the loop is over.
    const h = harness();
    const { graphRunId, nodeRunId } = graphWithRunningNode(h, 2);
    parkLaunchFailure(h.deps, graphRunId, nodeRunId, 'launch failed before the session started');
    expect(nodeOf(h, nodeRunId).status).toBe('blocked');
    expect(nodeOf(h, nodeRunId).failure_category).toBe('failed-to-launch');
    expect(nodeOf(h, nodeRunId).launch_fail_streak).toBe(0);
  });
});

describe('nodePromptWithReporter', () => {
  it('shows explicit CLI invocation syntax for complete, block, and replan', () => {
    const prompt = nodePromptWithReporter({
      promptBytesOf: () => new TextEncoder().encode('# Node Task'),
      cliNodeCompletionCommand: () => 'node "/path/to/cli.js" node complete',
    });
    expect(prompt).toContain('# Node Task');
    expect(prompt).toContain(
      'Report your outcome with:\n- `node "/path/to/cli.js" node complete`\n- `node "/path/to/cli.js" node block --reason "<why>"`\n- `node "/path/to/cli.js" node replan --reason "<why>"`',
    );
  });
});

describe('resolveGraphNodeProfile — preset and approach rungs, gates and source', () => {
  const config = graphApproachConfig({
    profiles: {
      expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
      custom: { provider: 'antigravity', model: 'custom-model' },
    },
  });
  const presets = {
    active: { label: 'A', slots: { graphExpert: { provider: 'codex', model: 'gpt-5.5', effort: 'high' } } },
    mine: { label: 'M', slots: { graphExpert: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' } } },
  } as const;
  const none = { agentPreset: null };
  /** A ticket row with a stale single-agent trio (T1301): a graph launch must ignore it. */
  const staleRow = { agentPreset: null, agentProvider: 'opencode2', model: 'claude-opus-5', effort: 'max' };

  it('returns source preset for a slot and approach for the config profile', () => {
    const m = testManifest({ agentPresets: presets, activeAgentPreset: 'active' } as never);
    expect(resolveGraphNodeProfile(m, config, 'expert', none)?.source).toBe('preset');
    expect(resolveGraphNodeProfile(testManifest(), config, 'expert', none)?.source).toBe('approach');
  });

  it('lets the ticket agentPreset beat the active preset', () => {
    const m = testManifest({ agentPresets: presets, activeAgentPreset: 'active' } as never);
    const r = resolveGraphNodeProfile(m, config, 'expert', { ...none, agentPreset: 'mine' });
    expect(r).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', source: 'preset' });
  });

  it('ignores the ticket provider/model/effort: the active graphExpert slot wins (AC-63)', () => {
    const m = testManifest({ agentPresets: presets, activeAgentPreset: 'active' } as never);
    const r = resolveGraphNodeProfile(m, config, 'expert', ticketLaunchFields(staleRow));
    expect(r).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'high', source: 'preset' });
  });

  it('ignores the ticket trio with no preset: the approach expert profile wins (AC-63)', () => {
    const r = resolveGraphNodeProfile(testManifest(), config, 'expert', ticketLaunchFields(staleRow));
    expect(r).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high', source: 'approach' });
  });

  it('reads only agentPreset from a ticket row', () => {
    expect(ticketLaunchFields({ ...staleRow, agentPreset: 'mine' })).toEqual({ agentPreset: 'mine' });
  });

  it('falls through a dangling ticket agentPreset to the approach profile (T1266)', () => {
    const m = testManifest({ agentPresets: presets, activeAgentPreset: 'active' } as never);
    const r = resolveGraphNodeProfile(m, config, 'expert', { agentPreset: 'gone' });
    expect(r).toMatchObject({ provider: 'claude', model: 'claude-opus-5', source: 'approach' });
  });

  it('drops a codex slot that carries a Claude model and falls back to the approach profile', () => {
    const bad = { bad: { label: 'B', slots: { graphWorker: { provider: 'codex', model: 'claude-opus-5' } } } };
    const m = testManifest({ agentPresets: bad, activeAgentPreset: 'bad' } as never);
    const debug = vi.fn();
    const r = resolveGraphNodeProfile(m, config, 'worker', none, debug);
    expect(r).toEqual({ provider: 'claude', model: 'claude-sonnet-5', effort: 'low', source: 'approach' });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('dropped'));
  });

  it('removes an effort the model does not advertise', () => {
    const odd = { odd: { label: 'O', slots: { graphExpert: { provider: 'codex', model: 'gpt-5.5', effort: 'turbo' } } } };
    const m = testManifest({ agentPresets: odd, activeAgentPreset: 'odd' } as never);
    const r = resolveGraphNodeProfile(m, config, 'expert', none);
    expect(r).toMatchObject({ provider: 'codex', model: 'gpt-5.5' });
    expect(r?.effort).toBeUndefined();
  });

  it('refuses prototype-chain profile ids', () => {
    expect(resolveGraphNodeProfile(testManifest(), config, 'toString', none)).toBeUndefined();
    expect(resolveGraphNodeProfile(testManifest(), config, '__proto__', none)).toBeUndefined();
  });

  it('keeps profile ids outside expert/worker/fast config-only', () => {
    const m = testManifest({ agentPresets: presets, activeAgentPreset: 'active' } as never);
    expect(resolveGraphNodeProfile(m, config, 'custom', none)).toMatchObject({
      provider: 'antigravity',
      source: 'approach',
    });
  });
});

describe('planner launches resolve through the preset-aware resolver', () => {
  const slotManifest = (): Manifest =>
    testManifest({
      agentPresets: {
        smart: { label: 'S', slots: { graphExpert: { provider: 'codex', model: 'gpt-5.5', effort: 'high' } } },
        mine: { label: 'M', slots: { graphExpert: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' } } },
      },
      activeAgentPreset: 'smart',
    } as never);

  function spyAdapters(h: Harness): string[] {
    const providers: string[] = [];
    h.deps.adapterFor = (provider) => {
      providers.push(provider);
      return fakeAdapter();
    };
    return providers;
  }
  const interactiveOf = (h: Harness) =>
    (h.starts[0] as { interactive: { model?: string; effort?: string } }).interactive;

  it('applies the graphExpert slot on bootstrap', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    const providers = spyAdapters(h);
    const result = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', projectSlug: 'acme',
    });
    expect(result.kind).toBe('launched');
    expect(providers).toContain('codex');
    expect(interactiveOf(h)).toMatchObject({ model: 'gpt-5.5', effort: 'high' });
  });

  it('lets the ticket agentPreset beat the active preset on bootstrap', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    h.deps.ticketLaunchFieldsOf = () => ({ agentPreset: 'mine' });
    await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', projectSlug: 'acme',
    });
    expect(interactiveOf(h)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'low' });
  });

  it('applies the graphExpert slot on relaunch', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    const providers = spyAdapters(h);
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', now: NOW,
    });
    h.db
      .prepare(`INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 1, 'bootstrap', 'stale')`)
      .run(graphRunId);
    const result = await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(result.kind).toBe('launched');
    expect(providers).toContain('codex');
    expect(interactiveOf(h)).toMatchObject({ model: 'gpt-5.5', effort: 'high' });
  });

  it('applies the graphExpert slot on replan', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    const providers = spyAdapters(h);
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', now: NOW,
    });
    h.db
      .prepare(`INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 2, 'replan', 'ready')`)
      .run(graphRunId);
    const plannerRunId = plannerRunIdFor(h.db, graphRunId);
    const result = await launchReplanPlanner(h.deps, {
      graphRunId, plannerRunId, generation: '', capability: '', prompt: '# replan',
      cwd: join(h.root, 'wt'), repo: 'api',
    });
    expect(result.kind).toBe('launched');
    expect(providers).toContain('codex');
    expect(interactiveOf(h)).toMatchObject({ model: 'gpt-5.5', effort: 'high' });
  });

  it('ignores a stale ticket core on bootstrap and replan: graphExpert still launches (T1301)', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    const providers = spyAdapters(h);
    const row = { agentPreset: null, agentProvider: 'opencode2', model: 'kimi-k2', effort: 'max' };
    h.deps.ticketLaunchFieldsOf = () => ticketLaunchFields(row);
    const boot = await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', projectSlug: 'acme',
    });
    expect(boot.kind).toBe('launched');
    const graphRunId = Number((h.db.prepare('SELECT MAX(id) AS id FROM approach_graph_runs').get() as { id: number }).id);
    h.db
      .prepare(`INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 9, 'replan', 'ready')`)
      .run(graphRunId);
    const plannerRunId = Number(
      (h.db.prepare('SELECT MAX(id) AS id FROM approach_planner_runs').get() as { id: number }).id,
    );
    const replan = await launchReplanPlanner(h.deps, {
      graphRunId, plannerRunId, generation: '', capability: '', prompt: '# replan',
      cwd: join(h.root, 'wt'), repo: 'api',
    });
    expect(replan.kind).toBe('launched');
    expect(providers).not.toContain('opencode2');
    expect(h.starts).toHaveLength(2);
    for (const start of h.starts) {
      expect((start as { interactive: { model?: string; effort?: string } }).interactive).toMatchObject({
        model: 'gpt-5.5',
        effort: 'high',
      });
    }
  });

  it('ignores a stale ticket core on a replan with no preset: the approach expert launches', async () => {
    const h = harness();
    const providers = spyAdapters(h);
    const row = { agentPreset: null, agentProvider: 'opencode2', model: 'kimi-k2', effort: 'max' };
    h.deps.ticketLaunchFieldsOf = () => ticketLaunchFields(row);
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', now: NOW,
    });
    h.db
      .prepare(`INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 2, 'replan', 'ready')`)
      .run(graphRunId);
    const result = await launchReplanPlanner(h.deps, {
      graphRunId, plannerRunId: plannerRunIdFor(h.db, graphRunId), generation: '', capability: '', prompt: '# replan',
      cwd: join(h.root, 'wt'), repo: 'api',
    });
    expect(result.kind).toBe('launched');
    expect(providers).toEqual(['claude']);
    expect(interactiveOf(h)).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
  });

  const plannerRow = (h: Harness) =>
    h.db
      .prepare('SELECT profile, provider, model, effort, status FROM approach_planner_runs ORDER BY id DESC LIMIT 1')
      .get() as { profile: string; provider: string; model: string; effort: string; status: string };

  it('records the resolved identity on the bootstrap planner row', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', projectSlug: 'acme',
    });
    expect(plannerRow(h)).toMatchObject({
      status: 'running', profile: 'expert', provider: 'codex', model: 'gpt-5.5', effort: 'high',
    });
    expect((h.starts[0] as { identity?: unknown }).identity).toMatchObject({ provider: 'codex', profile: 'expert' });
  });

  it('records the resolved identity on a relaunched and a replan planner row', async () => {
    const h = harness();
    h.deps.manifest = slotManifest();
    const graphRunId = createGraphRun(h.db, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', now: NOW,
    });
    h.db
      .prepare(`INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 1, 'bootstrap', 'stale')`)
      .run(graphRunId);
    await relaunchBootstrapPlanner(h.deps, { graphRunId });
    expect(plannerRow(h)).toMatchObject({ provider: 'codex', model: 'gpt-5.5', effort: 'high', profile: 'expert' });
    h.db
      .prepare(`INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status) VALUES (?, 9, 'replan', 'ready')`)
      .run(graphRunId);
    const plannerRunId = Number(
      (h.db.prepare('SELECT MAX(id) AS id FROM approach_planner_runs').get() as { id: number }).id,
    );
    await launchReplanPlanner(h.deps, {
      graphRunId, plannerRunId, generation: '', capability: '', prompt: '# replan',
      cwd: join(h.root, 'wt'), repo: 'api',
    });
    expect(plannerRow(h)).toMatchObject({ status: 'running', provider: 'codex', model: 'gpt-5.5', profile: 'expert' });
  });

  it('uses the approach profile when no slot is present', async () => {
    const h = harness();
    await bootstrapAndLaunchPlanner(h.deps, {
      ticketId: h.ticketId, stageAttempt: 0, approachId: 'karst-graph-engineering', projectSlug: 'acme',
    });
    expect(interactiveOf(h)).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
  });
});
