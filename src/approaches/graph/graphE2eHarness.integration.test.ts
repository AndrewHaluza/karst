/**
 * E2E harness for the dynamic graph approach — real CLI + real temp-file
 * registry + real git.
 *
 * The graph in-process suites (`driver.test.ts`, `integration/pipeline.integration.test.ts`) seed graph
 * runs in-process with an in-memory store and faked transport/git. This
 * harness drives the full lifecycle against a REAL SQLite file through
 * `openGraphWritableStore` (node:sqlite, the exact seam an agent session
 * invokes) and the REAL CLI verbs, faking only the agent transport and the
 * workspace-provider clone (no real agent CLI exists).
 *
 * Imported by the graph e2e suites; it also declares one smoke test of its
 * own. It is named `*.integration.test.*` because it spawns real git, so the
 * integration config runs it (it is excluded from the unit suite).
 */

import { expect } from 'vitest';
import { describe, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../cli/main.js';
import { openGraphWritableStore } from '../../cli/writableStore.js';
import { graphApproachConfig, manifest, repo } from '../../manifest/fixtures.js';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import type { CompileContext } from './compile.js';
import type { GraphDriverDeps } from './driver.js';
import {
  bootstrapAndLaunchPlanner,
  acceptSubmittedPlan,
  acceptSubmittedReplan,
  compileDiagnosticsSection,
  driveReadyNodeRuns,
  launchReplanPlanner,
  plannerVocabularyFor,
  PLANNER_SUBMIT_INSTRUCTION,
  readPlannerDiagnostics,
  sha256Hex,
} from './driver.js';
import { runCompletionPipeline, type CompletionPipelineDeps } from './integration/pipeline.js';
import { beginReplanPlannerRun, electReplan } from './coordinator/replan.js';
import { flipOnEndQuiescence } from './coordinator/completion.js';
import { reconcileGraphRun, type ReconcileGraphRunDeps, type ReconcileGraphRunResult } from './coordinator/reconcile.js';
import { runImmediateTransaction } from '../../store/transactions.js';
import { casStatus, GRAPH_RUN_TRANSITIONS } from '../../store/graph/transitions.js';
import { graphRunIdTicketStatus, graphRunStatus, markGraphRunBlocked } from '../../store/graph/graphRuns.js';
import { earliestNodeRunOutcomeForGraphRun, nodeRunIdsInStatusesForGraphRun } from '../../store/graph/nodeRuns.js';
import { blockGraphStage, markGraphAwaitingImplMarker } from '../../workflow/graphMarkerGuard.js';
import { runGraphCommand } from '../../cli/graph.js';
import { runCoordinatorTick } from './coordinator/sweep.js';
import { activationDomainKeys, type AllowlistCommandAccess } from './coordinator/conflicts.js';
import type { ActivationDomain } from './coordinator/leases.js';
import type { BaseHead } from '../../store/graph/nodeRuns.js';
import type { SupervisedAgentSession, SupervisedLaunchRequest } from './transport/supervisedCliTransport.js';
import { createSupervisedCliTransport } from './transport/supervisedCliTransport.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { SUPPORTED } from '../../agent/surfaces.js';
import { domainKeyOf } from './integration/domains.js';
import { canonicalPath } from '../../runtime/pathScope.js';
import { systemAsyncProcessFacts } from '../../runtime/serverIdentity.js';

export const NOW = '2026-08-15T00:00:00.000Z';
export const GRAPH_APPROACH = 'karst-graph-engineering';

/* ------------------------------------------------------------------ */
/* Real git helpers                                                    */
/* ------------------------------------------------------------------ */

export function git(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', exitCode: r.status ?? -1 };
}

export function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  return r.stdout;
}

function gitCommonDir(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--git-common-dir']);
  return r.exitCode === 0 ? r.stdout : null;
}

function existsFile(p: string): boolean {
  try {
    return readFileSync(p).length >= 0;
  } catch {
    return false;
  }
}

/** A real git repo with tracked `src/a.ts` and `outside.ts`. */
function makeRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-graph-e2e-repo-'));
  gitOk(dir, ['init', '-q', '-b', 'main']);
  gitOk(dir, ['config', 'user.email', 'e2e@karst']);
  gitOk(dir, ['config', 'user.name', 'E2E']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(dir, 'outside.ts'), 'x\n');
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-qm', 'base']);
  return { dir, head: gitOk(dir, ['rev-parse', 'HEAD']) };
}

function gitRunner() {
  return (args: string[], dir: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> => Promise.resolve(git(dir, args));
}

/* ------------------------------------------------------------------ */
/* Graph document (a minimal valid agent graph)                        */
/* ------------------------------------------------------------------ */

/** A minimal graph that compiles: one worker agent node reaching END. */
export function agentGraphJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    title: 'E2E graph',
    rationaleArtifact: 'task',
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
          reads: [{ repo: 'api', paths: ['src'] }],
          writes: [{ repo: 'api', paths: ['src'] }],
        },
        outcomes: ['complete', 'blocked', 'replan'],
        budget: { maxVisits: 1 },
      },
    ],
    edges: [{ id: 'e1', from: 'impl', on: 'complete', to: 'END' }],
    budgets: { maxNodeRuns: 5, maxExpertRuns: 3, maxReplans: 1 },
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

export interface Harness {
  dir: string;
  dbPath: string;
  artifactRoot: string;
  worktree: string;
  workspace: string;
  key: string;
  ticketId: number;
  projectId: number;
  store: ReturnType<typeof openGraphWritableStore>;
  config: GraphApproachConfig;
  transport: TestTransport;
  deps: GraphDriverDeps;
  pipelineDeps: CompletionPipelineDeps;
  sweepDeps: Parameters<typeof runCoordinatorTick>[0];
  /** The isolated clone of a node run (the shared `workspace` unless the
   *  harness was built with `isolatedWorkspaces`). */
  workspaceOfNode: (nodeRunId: number) => string;
  /** Every command-node process the driver spawned, in order. */
  commandRuns: CommandRun[];
  /** The exit code a command-node process returns (default: 0). Mutable. */
  commandExit: (run: CommandRun) => number;
  /** Every repair / replan planner prompt the tick helper composed. */
  plannerPrompts: { kind: 'repair' | 'replan'; prompt: string }[];
  close: () => void;
}

/** One command-node process the driver spawned. */
export interface CommandRun {
  command: string;
  args: readonly string[];
  cwd: string;
}

/** Optional harness shape; the default is the single-node, single-clone fixture. */
export interface HarnessOptions {
  /** Returns the graph approach config the run uses (default: the fixture). */
  configure?: (config: GraphApproachConfig) => GraphApproachConfig;
  /** Give every agent node run its own git clone (fan-out). */
  isolatedWorkspaces?: boolean;
  /** Record a durable `process_runs` row (pid `9000 + nodeRunId`) per node launch. */
  recordProcesses?: boolean;
}

/** OS facts that report every pid dead — a closed terminal / reloaded window. */
export const deadProcessFacts = {
  isAlive: () => false,
  liveCwd: () => null,
  processStartMs: () => null,
};

/** A fake supervised transport: records launches, returns a live session,
 *  and proves termination by `attributable: killed` on demand. */
export class TestTransport {
  sessionsByNode = new Map<number, SupervisedAgentSession>();
  killed = new Set<number>();
  started: SupervisedLaunchRequest[] = [];
  constructor(
    private h: {
      ticketId: number;
      graphRunId: () => number;
      startedAt: () => string;
      /** Persist the durable process identity of a node launch. */
      recordProcess?: (nodeRunId: number, pid: number, startedAt: string) => void;
    },
  ) {}

  capabilities(): { exactModel: boolean; attributedTermination: boolean } {
    return { exactModel: true, attributedTermination: true };
  }

  async start(request: SupervisedLaunchRequest): Promise<SupervisedAgentSession> {
    this.started.push(request);
    const session: SupervisedAgentSession = {
      nodeRunId: request.nodeRunId,
      ticketId: this.h.ticketId,
      graphRunId: request.graphRunId,
      pid: 9000 + request.nodeRunId,
      cwd: request.cwd,
      generation: request.generation,
      ownerNonce: 'nonce',
      startedAt: this.h.startedAt(),
      processRunId: null,
      providerSessionId: null,
    };
    this.sessionsByNode.set(request.nodeRunId, session);
    if (request.interactive.sessionName === `Karst node ${request.nodeRunId}`) {
      this.h.recordProcess?.(request.nodeRunId, session.pid ?? 0, session.startedAt ?? NOW);
    }
    return session;
  }

  async terminate(session: SupervisedAgentSession): Promise<{ kind: string; kill?: string }> {
    this.killed.add(session.nodeRunId);
    return { kind: 'attributable', kill: 'killed' };
  }

  sessions(): SupervisedAgentSession[] {
    return [...this.sessionsByNode.values()];
  }

  sessionFor(_ticketId: number, nodeRunId: number): SupervisedAgentSession | undefined {
    return this.sessionsByNode.get(nodeRunId);
  }
}

function sha256HexCommand(def: {
  command: string;
  args: string[];
  cwd: string;
  access: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
}): string {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        command: def.command,
        args: def.args,
        cwd: def.cwd,
        access: def.access,
        timeoutSeconds: def.timeoutSeconds,
        env: def.env ?? {},
      }),
    ),
  );
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'karst-graph-e2e-'));
  const dbPath = join(dir, 'karst.db');
  const artifactRoot = join(dir, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });

  // Real CLI: fresh registry + a graph-approach ticket at running impl.
  runCli(['test', 'reset', '--db', dbPath]);
  const created = JSON.parse(
    runCli([
      'test',
      'create-ticket',
      '--db',
      dbPath,
      '--key',
      'GRAPH-E2E',
      '--title',
      'graph e2e',
      '--approach',
      GRAPH_APPROACH,
    ]),
  ) as { id: number; key: string };
  const key = created.key;
  runCli(['test', 'set-stage', '--db', dbPath, '--ticket', key, '--stage', 'impl', '--status', 'running']);

  // Real registries: project binding (as `bindProject` would perform it) and
  // the store the graph driver + CLI verbs share.
  const store = openGraphWritableStore(dbPath);
  const projectId = Number(
    store.db.prepare("INSERT INTO projects (slug) VALUES ('e2e')").run().lastInsertRowid,
  );
  store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(projectId, created.id);

  // Real git: the canonical worktree + the node's isolated workspace clone.
  const repo = makeRepo();
  const worktree = repo.dir;
  const workspace = join(dir, 'ws');
  gitOk(dir, ['clone', '-q', worktree, workspace]);

  const config = options.configure ? options.configure(graphApproachConfig()) : graphApproachConfig();
  const nodeWorkspaces = new Map<number, string>();
  const transport = new TestTransport({
    ticketId: created.id,
    graphRunId: () => 0,
    startedAt: () => NOW,
    recordProcess: options.recordProcesses
      ? (nodeRunId, pid, startedAt) => {
          const processRunId = Number(
            store.db
              .prepare(
                `INSERT INTO process_runs
                   (ticket_id, stage_key, process_id, attempt, pid, status, started_at)
                 VALUES (?, 'impl', 'graph-node', 0, ?, 'running', ?)`,
              )
              .run(created.id, pid, startedAt).lastInsertRowid,
          );
          store.db
            .prepare('UPDATE approach_node_runs SET process_run_id = ? WHERE id = ?')
            .run(processRunId, nodeRunId);
        }
      : undefined,
  });
  const commandRuns: CommandRun[] = [];
  const fakeAdapter: AgentAdapter = {
    requiredBinary: 'opencode',
    runHeadless: async () => ({ sessionId: 's', verdict: null, raw: '' }),
    buildInteractiveCommand: () => ({ command: 'opencode', args: [], env: {} }),
    capabilities: { lifecycleEvents: true, resume: true },
    surfaces: {
      exactModel: SUPPORTED,
    } as never,
  };

  const compileContextOf = (document?: { artifacts: { id: string; path: string }[] }): CompileContext => ({
    profiles: new Map(
      Object.entries(config.profiles).map(([name]) => [name, name === 'expert' ? 'expert' : 'worker']),
    ),
    commands: new Map(
      Object.entries(config.commands).map(([id, def]) => [
        id,
        {
          id,
          fingerprint: sha256HexCommand(def),
          access: def.access,
          timeoutSeconds: def.timeoutSeconds,
          permittedRepositories: ['api'],
        },
      ]),
    ),
    repositories: new Map([
      [
        'api',
        {
          id: 'api',
          root: '',
          domain: domainKeyOf(canonicalPath(worktree), gitCommonDir(canonicalPath(worktree))),
        },
      ],
    ]),
    artifactFileExists: (artifactId: string) =>
      (document?.artifacts ?? []).some(
        (a) => a.id === artifactId && existsFile(join(artifactRoot, a.path)),
      ),
    expertSpend: {
      spentPlannerRuns: 1,
      permittedReplans: config.limits.maxReplans,
      bootstrapUnspent: false,
    },
    projectMaxima: {
      maxNodeRuns: config.limits.maxNodeRuns,
      maxExpertRuns: config.limits.maxExpertRuns,
      maxReplans: config.limits.maxReplans,
    },
  });

  const readBytes = (_graphRunId: number, rel: string): Uint8Array | undefined => {
    const target = rel.startsWith(join(artifactRoot, '')) ? rel : join(artifactRoot, rel);
    try {
      return new Uint8Array(readFileSync(target));
    } catch {
      return undefined;
    }
  };

  const transaction = <T>(fn: () => T): T => store.db.transaction(fn)();

  const deps: GraphDriverDeps = {
    db: store.db,
    transaction,
    now: () => NOW,
    debug: () => undefined,
    graphConfigOf: (approachId) => (approachId === GRAPH_APPROACH ? config : undefined),
    manifest: manifest({}, {}),
    artifactRootOf: () => artifactRoot,
    graphEnvOf: (input) => ({
      KARST_GRAPH_PROJECT: String(projectId),
      KARST_TICKET_ID: String(created.id),
      KARST_GRAPH_RUN_ID: String(input.graphRunId),
      KARST_LAUNCH_ID: String(input.launchId),
      KARST_GRAPH_GENERATION: input.generation,
      KARST_GRAPH_CAPABILITY: input.capability,
      KARST_GRAPH_ARTIFACT_ROOT: input.artifactRoot,
      KARST_GRAPH_DB: dbPath,
    }),
    adapterFor: () => fakeAdapter,
    transport: transport as unknown as GraphDriverDeps['transport'],
    promptBytesOf: (identity) =>
      new TextEncoder().encode(identity === 'karst-graph-planner' ? '# Planner' : '# Node'),
    writeSnapshot: (_graphRunId, rel, bytes) => {
      const target = join(artifactRoot, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
    },
    readBytes,
    ticketContextOf: async () => '# Ticket context',
    compileContextOf: (graphRunId, document) => compileContextOf(document),
    commandDefOf: (_graphRunId, commandId) => config.commands[commandId],
    runProcess: async (command, args, cwd) => {
      const run: CommandRun = { command, args, cwd };
      commandRuns.push(run);
      return { kind: 'completed', exitCode: harness.commandExit(run), output: '' };
    },
    plannerCwdOf: () => ({ repo: 'api', cwd: worktree }),
    cwdForRepo: () => worktree,
    gitCommonDirOf: (cwd) => gitCommonDir(cwd),
    workspaceOf: () => undefined,
    createWorkspace: async ({ nodeRunId }) => {
      let cwd = workspace;
      if (options.isolatedWorkspaces) {
        cwd = join(dir, `ws-${nodeRunId}`);
        gitOk(dir, ['clone', '-q', worktree, cwd]);
        gitOk(cwd, ['config', 'user.email', 'e2e@karst']);
        gitOk(cwd, ['config', 'user.name', 'E2E']);
        nodeWorkspaces.set(nodeRunId, cwd);
      }
      return { kind: 'created', paths: [{ repoName: 'api', cwd, domainKey: 'd' }] };
    },
    sessionNamingOf: (_graphRunId, runId, kind) => ({ name: `Karst ${kind} ${runId}` }),
    cliNodeCompletionCommand: () => 'node "/dist/cli/main.js" node complete',
  };

  const pipelineDeps: CompletionPipelineDeps = {
    db: store.db,
    transaction,
    now: () => NOW,
    debug: () => undefined,
    facts: systemAsyncProcessFacts,
    git: gitRunner(),
    gitCommonDirOf: (cwd) => gitCommonDir(cwd),
    transport: transport as unknown as CompletionPipelineDeps['transport'],
    getSession: (nodeRunId) => transport.sessionFor(created.id, nodeRunId),
    domainsFor: () => [{ repoName: 'api', worktreePath: worktree }],
    declaredWritesOf: (nodeRunId) => {
      const row = store.db
        .prepare('SELECT revision_id, node_id FROM approach_node_runs WHERE id = ?')
        .get(nodeRunId) as { revision_id: number; node_id: string } | undefined;
      if (!row) return [];
      const revision = store.db
        .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
        .get(row.revision_id) as { canonical_graph: string } | undefined;
      if (!revision) return [];
      const parsed = JSON.parse(revision.canonical_graph) as {
        nodes: { id: string; resources?: { writes: { repo: string; paths: string[] }[] } }[];
      };
      const node = parsed.nodes.find((n) => n.id === row.node_id);
      if (!node?.resources) return [];
      return node.resources.writes
        .filter((w) => w.repo === 'api')
        .map((w) => ({
          domainKey: domainKeyOf(canonicalPath(worktree), gitCommonDir(canonicalPath(worktree))),
          paths: w.paths,
        }));
    },
    artifactRoot: () => artifactRoot,
    workspaceCwdOf: (nodeRunId) => nodeWorkspaces.get(nodeRunId) ?? workspace,
    cleanupNodeWorkspace: () => undefined,
  };

  // The coordinator sweep's host bindings (the extension's
  // `runGraphCoordinatorTick`): capture base heads, resolve physical domains
  // from the node's declared claims, and apply the process ceiling.
  const sweepDeps = {
    db: store.db,
    transaction,
    now: () => NOW,
    debug: () => undefined,
    baseHeadsOf: (): BaseHead[] => {
      const head = git(worktree, ['rev-parse', 'HEAD']);
      return head.exitCode === 0
        ? [
            {
              domainKey: domainKeyOf(canonicalPath(worktree), gitCommonDir(canonicalPath(worktree))),
              commit: head.stdout,
            },
          ]
        : [];
    },
    domainsForActivation: (input: {
      graphRunId: number;
      revisionId: number;
      nodeId: string;
      nodeKind: 'agent' | 'command' | 'gate';
    }): ActivationDomain[] => {
      const revision = store.db
        .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
        .get(input.revisionId) as { canonical_graph: string } | undefined;
      if (!revision) return [];
      const parsed = JSON.parse(revision.canonical_graph) as {
        nodes: {
          id: string;
          kind: string;
          resources?: {
            reads: { repo: string; paths: string[] }[];
            writes: { repo: string; paths: string[] }[];
          };
          command?: string;
          repositories?: string[];
        }[];
      };
      const node = parsed.nodes.find((n) => n.id === input.nodeId);
      if (!node || node.kind === 'join') return [];
      const commands: AllowlistCommandAccess = new Map(
        Object.entries(config.commands).map(([id, def]) => [id, def.access]),
      );
      const physicalDomainOf = (repo: string): string | null =>
        repo === 'api'
          ? domainKeyOf(canonicalPath(worktree), gitCommonDir(canonicalPath(worktree)))
          : null;
      if (node.kind === 'agent') {
        return activationDomainKeys(
          {
            kind: 'agent',
            reads: node.resources?.reads ?? [],
            writes: node.resources?.writes ?? [],
          },
          commands,
          physicalDomainOf,
        );
      }
      if (node.kind !== 'command') return [];
      return activationDomainKeys(
        { kind: 'command', command: node.command ?? '', repositories: node.repositories ?? [] },
        commands,
        physicalDomainOf,
      );
    },
    maxParallelOf: () => config.limits.maxParallel,
  };

  const harness: Harness = {
    dir,
    dbPath,
    artifactRoot,
    worktree,
    workspace,
    key,
    ticketId: created.id,
    projectId,
    store,
    config,
    transport,
    deps,
    pipelineDeps,
    sweepDeps,
    workspaceOfNode: (nodeRunId) => nodeWorkspaces.get(nodeRunId) ?? workspace,
    commandRuns,
    commandExit: () => 0,
    plannerPrompts: [],
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/* ------------------------------------------------------------------ */
/* Lifecycle helpers                                                   */
/* ------------------------------------------------------------------ */

/** Write the planner's fixed artifact + graph.json into the artifact root. */
export function writePlannerSubmission(h: Harness, graphJson: string): void {
  mkdirSync(join(h.artifactRoot, 'artifacts'), { recursive: true });
  writeFileSync(join(h.artifactRoot, 'artifacts', 'task.md'), '# task');
  writeFileSync(join(h.artifactRoot, 'graph.json'), graphJson);
}

/** The KARST_GRAPH_* env record the CLI verbs read. */
export function graphEnv(
  h: Harness,
  over: { graphRunId: string; launchId: string; generation: string; capability: string },
): Record<string, string> {
  return {
    KARST_GRAPH_PROJECT: String(h.projectId),
    KARST_TICKET_ID: String(h.ticketId),
    KARST_GRAPH_RUN_ID: over.graphRunId,
    KARST_LAUNCH_ID: over.launchId,
    KARST_GRAPH_GENERATION: over.generation,
    KARST_GRAPH_CAPABILITY: over.capability,
    KARST_GRAPH_ARTIFACT_ROOT: h.artifactRoot,
  };
}

/** Launch the bootstrap planner, then submit its graph.json through the REAL
 *  `graph submit` CLI and accept the plan. Returns the graph run id. */
export async function bootAndSubmit(
  h: Harness,
  graphJson: string = agentGraphJson(),
): Promise<{
  graphRunId: number;
  plannerRunId: number;
  generation: string;
  capability: string;
}> {
  const launched = await bootstrapAndLaunchPlanner(h.deps, {
    ticketId: h.ticketId,
    stageAttempt: 0,
    approachId: GRAPH_APPROACH,
    projectSlug: 'e2e',
  });
  expect(launched.kind).toBe('launched');
  if (launched.kind !== 'launched') throw new Error('bootstrap did not launch');
  writePlannerSubmission(h, graphJson);
  const out = JSON.parse(
    runGraphCommand(
      h.store,
      graphEnv(h, {
        graphRunId: String(launched.graphRunId),
        launchId: String(launched.plannerRunId),
        generation: launched.generation,
        capability: launched.capability,
      }),
      ['graph', 'submit'],
      () => NOW,
    ),
  ) as { ok: boolean; rejected?: string };
  expect(out.ok).toBe(true);
  const accepted = acceptSubmittedPlan(h.deps, launched.graphRunId);
  if (accepted.kind !== 'accepted') {
    const run = h.store.db
      .prepare('SELECT blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(launched.graphRunId) as { blocked_reason: string | null };
    throw new Error(`plan rejected: ${run.blocked_reason}`);
  }
  return {
    graphRunId: launched.graphRunId,
    plannerRunId: launched.plannerRunId,
    generation: launched.generation,
    capability: launched.capability,
  };
}

/** The plaintext capability minted for a node launch, recovered from the
 *  recorded launch request's graph env — the ONLY place it exists (the DB
 *  stores the hash; the agent's session carries the secret). The bootstrap
 *  planner launch shares the numeric id space with node launches (both are
 *  `nodeRunId`), so the session name disambiguates the two. */
export function nodeCapabilityOf(h: Harness, nodeRunId: number): string {
  const launch = h.transport.started.find(
    (s) => s.nodeRunId === nodeRunId && s.interactive.sessionName === `Karst node ${nodeRunId}`,
  );
  const cap = launch?.graphEnv?.KARST_GRAPH_CAPABILITY;
  if (!cap) throw new Error(`no recorded node launch for node run ${nodeRunId}`);
  return cap;
}

/** Claim the pending entry tokens into node runs (the coordinator sweep),
 *  then execute every ready node run. Loops until the run settles (a gate or
 *  command that completes deterministically mints successors that a later
 *  sweep claims), so a multi-node graph is driven to its agent launch. */
export async function claimAndDrive(
  h: Harness,
  graphRunId: number,
): Promise<Awaited<ReturnType<typeof driveReadyNodeRuns>>> {
  const total: Awaited<ReturnType<typeof driveReadyNodeRuns>> = {
    launched: 0,
    completed: 0,
    blocked: 0,
  };
  for (let i = 0; i < 20; i++) {
    const sweep = runCoordinatorTick(h.sweepDeps, { graphRunId });
    const driven = await driveReadyNodeRuns(h.deps, graphRunId);
    total.launched += driven.launched;
    total.completed += driven.completed;
    total.blocked += driven.blocked;
    if (sweep.claimed === 0 && driven.launched === 0 && driven.completed === 0) break;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Autonomous coordinator tick                                         */
/* ------------------------------------------------------------------ */

/** Compose a repair / replan planner prompt the way the extension host does
 *  (`launchPlannerRepairHost` / `launchReplanPlannerHost`): the base prompt, the
 *  ticket context, the planner vocabulary, then the situation text. */
function plannerPromptOf(h: Harness, graphRunId: number, situation: string[]): string {
  return [
    '# Planner',
    '# Ticket context',
    plannerVocabularyFor(() => h.deps.compileContextOf(graphRunId), h.artifactRoot, () => undefined),
    ...situation,
    PLANNER_SUBMIT_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The host's compile-repair re-prompt: the SAME planner run gets its next
 *  attempt, with the compile diagnostics, through `launchReplanPlanner`. */
async function launchRepairPlanner(
  h: Harness,
  graphRunId: number,
  plannerRunId: number,
  attempt: number,
): Promise<void> {
  const diagnostics = compileDiagnosticsSection(readPlannerDiagnostics(h.deps, graphRunId, plannerRunId));
  const prompt = plannerPromptOf(h, graphRunId, [
    diagnostics ?? 'The compiler rejected the previous `graph.json`.',
    `This is compile attempt ${attempt + 1}: write a corrected \`graph.json\` and submit it again.`,
  ]);
  h.plannerPrompts.push({ kind: 'repair', prompt });
  const launched = await launchReplanPlanner(h.deps, {
    graphRunId,
    plannerRunId,
    generation: '',
    capability: '',
    prompt,
    cwd: h.worktree,
    repo: 'api',
    isRepair: true,
  });
  if (launched.kind !== 'launched') throw new Error(`repair planner did not launch: ${launched.kind}`);
}

/** Allocate the elected replan planner run and start its session (the host's
 *  `relaunchReplanPlannerHost` + `launchReplanPlannerHost`). */
async function launchElectedReplanPlanner(h: Harness, graphRunId: number): Promise<void> {
  const begun = beginReplanPlannerRun(
    {
      db: h.store.db,
      transaction: h.deps.transaction,
      now: () => NOW,
      debug: () => undefined,
      writeSnapshot: h.deps.writeSnapshot,
      readPrompt: () => new TextEncoder().encode('# Planner'),
      promptPath: 'karst-graph-planner',
      ticketContext: '# Ticket context',
    },
    { graphRunId },
  );
  if (!begun.ok) throw new Error(`replan planner not allocated: ${begun.reason}`);
  const prompt = plannerPromptOf(h, graphRunId, [
    `Replan the graph (superseding revision ${begun.launch.priorRevisionNumber}). The replan reasons are under the artifact root: ${begun.launch.reasonsSnapshotPath}.`,
  ]);
  h.plannerPrompts.push({ kind: 'replan', prompt });
  const launched = await launchReplanPlanner(h.deps, {
    graphRunId,
    plannerRunId: begun.launch.plannerRunId,
    generation: '',
    capability: '',
    prompt,
    cwd: h.worktree,
    repo: 'api',
  });
  if (launched.kind !== 'launched') throw new Error(`replan planner did not launch: ${launched.kind}`);
}

/** The host's `settleGraphRun`: a blocked node blocks the run (or elects a
 *  replan), an END-quiescent run flips to `completed-awaiting-impl-marker`. */
async function settleRun(h: Harness, graphRunId: number): Promise<void> {
  const db = h.store.db;
  const run = graphRunIdTicketStatus(db, graphRunId);
  if (!run) return;
  const clock = () => NOW;
  if (run.status === 'blocked') {
    blockGraphStage(h.store, run.ticket_id, graphRunId, clock);
    return;
  }
  if (run.status !== 'running') return;
  const blockedNode = earliestNodeRunOutcomeForGraphRun(db, graphRunId, ['blocked']);
  if (blockedNode) {
    if (blockedNode.outcome === 'replan') {
      const elected = electReplan(
        { db, transaction: h.deps.transaction, now: clock, debug: () => undefined },
        { graphRunId, requestNodeRunId: blockedNode.id },
      );
      if (elected.elected) await launchElectedReplanPlanner(h, graphRunId);
      return;
    }
    const reason = `node-blocked: node ${blockedNode.id} (${blockedNode.reason ?? 'blocked by agent'})`;
    const blocked = runImmediateTransaction(db, () => {
      if (!casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, 'running', 'blocked')) {
        return false;
      }
      markGraphRunBlocked(db, graphRunId, reason, NOW);
      return true;
    });
    if (blocked) blockGraphStage(h.store, run.ticket_id, graphRunId, clock);
    return;
  }
  const flipped = flipOnEndQuiescence(
    { db, transaction: h.deps.transaction, now: clock, debug: () => undefined },
    { graphRunId },
  );
  if (flipped.flipped) markGraphAwaitingImplMarker(h.store, run.ticket_id, graphRunId, clock);
}

/**
 * ONE pass of the extension host's coordinator loop for a graph run
 * (`runGraphCoordinatorTick` + `driveGraphRunContinuation`):
 *  - `planning`: judge the submitted plan; a repair request re-prompts the planner.
 *  - `draining`: judge the submitted replan; a repair request re-prompts it.
 *  - `running`: claim tokens, drive ready nodes, drive `completing` nodes
 *    through the completion pipeline; settle (blocked / replan / END) before and after.
 * The agent's work between ticks goes through the REAL CLI verbs. Returns the
 * run's status after the pass.
 */
export async function tickGraphRun(h: Harness, graphRunId: number): Promise<string> {
  const db = h.store.db;
  const status = graphRunStatus(db, graphRunId);
  if (status === 'planning') {
    const accepted = acceptSubmittedPlan(h.deps, graphRunId);
    if (accepted.kind === 'repair-requested') {
      await launchRepairPlanner(h, graphRunId, accepted.plannerRunId, accepted.attempt);
    }
  } else if (status === 'draining') {
    const accepted = acceptSubmittedReplan(h.deps, graphRunId);
    if (accepted.kind === 'repair-requested') {
      await launchRepairPlanner(h, graphRunId, accepted.plannerRunId, accepted.attempt);
    }
    if (accepted.kind === 'accepted') await claimAndDrive(h, graphRunId);
  } else if (status === 'running') {
    // Host order (`runGraphCoordinatorTick`): settle FIRST (a `replan` request
    // elects before the sweep can read its blocked node run as a fault), then
    // the sweep, then the continuation drives completing nodes and settles again.
    await settleRun(h, graphRunId);
    if (graphRunStatus(db, graphRunId) === 'running') {
      await claimAndDrive(h, graphRunId);
      for (const nodeRunId of nodeRunIdsInStatusesForGraphRun(db, graphRunId, ['completing'])) {
        await runCompletionPipeline(h.pipelineDeps, { graphRunId, nodeRunId });
      }
      await settleRun(h, graphRunId);
    }
  }
  return graphRunStatus(db, graphRunId) ?? 'gone';
}

/** Tick until `done` holds for the run's status (bounded). */
export async function tickUntil(
  h: Harness,
  graphRunId: number,
  done: (status: string) => boolean,
  maxTicks = 12,
): Promise<string> {
  let status = graphRunStatus(h.store.db, graphRunId) ?? 'gone';
  for (let i = 0; i < maxTicks && !done(status); i++) status = await tickGraphRun(h, graphRunId);
  return status;
}

/** A window reload: drop every in-memory session, then run the REAL reconcile
 *  pass. A node proven dead is handed to the completion pipeline (awaited). */
export async function reconcileAfterReload(
  h: Harness,
  graphRunId: number,
  facts: ReconcileGraphRunDeps['facts'] = deadProcessFacts,
): Promise<{ result: ReconcileGraphRunResult; relaunched: string[] }> {
  h.transport.sessionsByNode.clear();
  const resumed: Promise<unknown>[] = [];
  const relaunched: string[] = [];
  const deps: ReconcileGraphRunDeps = {
    db: h.store.db,
    transaction: h.deps.transaction,
    now: () => NOW,
    debug: () => undefined,
    facts,
    sessionFor: () => undefined,
    resumePipeline: (nodeRunId) => {
      resumed.push(runCompletionPipeline({ ...h.pipelineDeps, facts }, { graphRunId, nodeRunId }));
    },
    relaunchPlanner: (id) => void relaunched.push(`planner:${id}`),
    relaunchReplanPlanner: (id) => void relaunched.push(`replan:${id}`),
    relaunchCompileRepair: (id, plannerRunId) => void relaunched.push(`repair:${id}:${plannerRunId}`),
  };
  const result = await reconcileGraphRun(deps, { graphRunId });
  await Promise.all(resumed);
  return { result, relaunched };
}

/** A REAL supervised transport with minimal fakes — enough to assert the
 *  capability contract the driver's agent-node gate reads. */
export function realTransport(): ReturnType<typeof createSupervisedCliTransport> {
  return createSupervisedCliTransport({
    terminalHost: {
      createTerminal: () => ({
        processId: async () => 4242,
        show: () => undefined,
        sendText: () => undefined,
        dispose: () => undefined,
        onDidClose: () => undefined,
      }),
    },
    recordSession: () => undefined,
    now: () => NOW,
  });
}

describe('graph e2e harness', () => {
  it('builds a clean real-CLI + real-git fixture (a broken harness fails loudly here)', () => {
    const h = makeHarness();
    try {
      expect(h.key).toBe('GRAPH-E2E');
      const head = git(h.worktree, ['rev-parse', '--is-inside-work-tree']);
      expect(head.exitCode).toBe(0);
      const rev = h.store.db
        .prepare('SELECT status, approach_id FROM approach_graph_runs')
        .all() as { status: string; approach_id: string }[];
      expect(rev).toEqual([]);
    } finally {
      h.close();
    }
  });
});
