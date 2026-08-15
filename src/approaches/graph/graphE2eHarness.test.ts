/**
 * E2E harness for the dynamic graph approach — real CLI + real temp-file
 * registry + real git.
 *
 * The graph unit suites (`driver.test.ts`, `pipeline.test.ts`) seed graph
 * runs in-process with an in-memory store and faked transport/git. This
 * harness drives the full lifecycle against a REAL SQLite file through
 * `openGraphWritableStore` (node:sqlite, the exact seam an agent session
 * invokes) and the REAL CLI verbs, faking only the agent transport and the
 * workspace-provider clone (no real agent CLI exists).
 *
 * Imported by the graph e2e suites; it declares no tests of its own. No
 * better-sqlite3 is touched anywhere, so it is ABI-agnostic like the other
 * e2e suites.
 */

import { expect } from 'vitest';
import { describe, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../cli/main.js';
import { openGraphWritableStore } from '../../cli/writableStore.js';
import { graphApproachConfig } from '../../manifest/fixtures.js';
import type { GraphApproachConfig } from '../../manifest/types.js';
import type { CompileContext } from './compile.js';
import type { GraphDriverDeps } from './driver.js';
import {
  bootstrapAndLaunchPlanner,
  acceptSubmittedPlan,
  driveReadyNodeRuns,
  sha256Hex,
} from './driver.js';
import type { CompletionPipelineDeps } from './integration/pipeline.js';
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

export const NOW = '2026-08-15T00:00:00.000Z';
export const GRAPH_APPROACH = 'karst-graph-engineering';

/* ------------------------------------------------------------------ */
/* Real git helpers                                                    */
/* ------------------------------------------------------------------ */

function git(cwd: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', exitCode: r.status ?? -1 };
}

function gitOk(cwd: string, args: string[]): string {
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
  close: () => void;
}

/** A fake supervised transport: records launches, returns a live session,
 *  and proves termination by `attributable: killed` on demand. */
export class TestTransport {
  sessionsByNode = new Map<number, SupervisedAgentSession>();
  killed = new Set<number>();
  started: SupervisedLaunchRequest[] = [];
  constructor(private h: { ticketId: number; graphRunId: () => number; startedAt: () => string }) {}

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

export function makeHarness(): Harness {
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

  const config = graphApproachConfig();
  const transport = new TestTransport({
    ticketId: created.id,
    graphRunId: () => 0,
    startedAt: () => NOW,
  });
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
    ticketContextOf: () => '# Ticket context',
    compileContextOf: (graphRunId, document) => compileContextOf(document),
    commandDefOf: () => undefined,
    runProcess: async () => ({ kind: 'completed', exitCode: 0, output: '' }),
    plannerCwdOf: () => ({ repo: 'api', cwd: worktree }),
    cwdForRepo: () => worktree,
    gitCommonDirOf: (cwd) => gitCommonDir(cwd),
    workspaceOf: () => undefined,
    createWorkspace: async () => ({
      kind: 'created',
      paths: [{ repoName: 'api', cwd: workspace, domainKey: 'd' }],
    }),
    sessionNameOf: (id, kind) => `${kind} ${id}`,
    cliNodeCompletionCommand: () => 'node "/dist/cli/main.js" node complete',
  };

  const pipelineDeps: CompletionPipelineDeps = {
    db: store.db,
    transaction,
    now: () => NOW,
    debug: () => undefined,
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
    workspaceCwdOf: () => workspace,
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

  return {
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
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
export async function bootAndSubmit(h: Harness): Promise<{
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
  writePlannerSubmission(h, agentGraphJson());
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
    persistOwnerNonce: () => undefined,
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
