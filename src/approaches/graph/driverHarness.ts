/**
 * Shared scaffold of the graph driver tests: an in-memory store, a fake
 * transport that records every launch request, and fake prompts and adapters.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../store/db.js';
import { latestPlannerRunForGraphRunKind } from '../../store/graph/plannerRuns.js';
import { graphApproachConfig, manifest, repo } from '../../manifest/fixtures.js';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import { SUPPORTED } from '../../agent/surfaces.js';
import type { CompileContext } from './compile.js';
import type { GraphDriverDeps as Deps } from './driver.js';
import type { SupervisedAgentSession, SupervisedLaunchRequest } from './transport/supervisedCliTransport.js';
import { SUPERVISED_CLI_TRANSPORT_CAPABILITIES } from './transport/supervisedCliTransport.js';
import type { AgentAdapter } from '../../agent/adapter.js';

export const NOW = '2026-08-13T00:00:00.000Z';

/** A minimal valid graph: one gate reaching END on both outcomes. */
export function gateGraphJson(overrides: Record<string, unknown> = {}): string {
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

export function compileContextOf(): CompileContext {
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
    spentNodeRuns: 0,
    projectMaxima: { maxNodeRuns: 200, maxExpertRuns: 10, maxReplans: 5 },
  };
}

export function testManifest(over: Partial<Manifest> = {}): Manifest {
  return manifest(
    { extention: repo() },
    {
      agentProvider: 'opencode',
      defaultModel: 'mimo-2.5',
      defaultEffort: 'low',
      ...over,
    },
  );
}

export function fakeAdapter(): AgentAdapter {
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

export interface Harness {
  db: ReturnType<typeof openStore>['db'];
  root: string;
  ticketId: number;
  starts: Record<string, unknown>[];
  deps: Deps;
  config: GraphApproachConfig;
}

export function harness(config: GraphApproachConfig = graphApproachConfig()): Harness {
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
    manifest: testManifest(),
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
    unlinkArtifact: (graphRunId, rel) => {
      try {
        rmSync(join(root, String(graphRunId), rel), { force: true });
      } catch {}
    },
    readBytes,
    ticketContextOf: async () => '# Ticket context',
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

export function plannerRunIdFor(db: Harness['db'], graphRunId: number): number {
  const row = latestPlannerRunForGraphRunKind(db, graphRunId, 'bootstrap') ?? latestPlannerRunForGraphRunKind(db, graphRunId, 'replan');
  return row!.id;
}

/** A graph run in `running` (the state the coordinator + driver execute on). */
export function runningGraphRun(h: Harness, graphRunId: number): void {
  h.db.prepare('UPDATE approach_graph_runs SET status = \'running\' WHERE id = ?').run(graphRunId);
}

