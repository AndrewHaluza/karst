/**
 * Shared manifest builders for tests.
 *
 * Test-only: excluded from `tsconfig.build.json` so it never ships in `dist/`.
 * It lives beside the model rather than under a `__fixtures__` folder because it
 * is the model's own test vocabulary — when the manifest shape changes, this is
 * the one file that has to follow it.
 *
 * Before this module, ~26 hand-inlined manifest literals and six copy-pasted
 * `svc()` factories were spread across 18 test files, so every shape change was
 * a 26-file diff in which a real regression could hide among the mechanical
 * edits. Build fixtures from here instead; pass overrides for the one field the
 * test is actually about.
 *
 * Every builder returns a fresh object and never mutates its arguments.
 */

import type {
  ApproachDef,
  BindVar,
  DependsOn,
  GraphApproachConfig,
  Manifest,
  PortSlot,
  ProcessAssignmentsConfig,
  RepositoryDef,
  ReviewConfig,
  ServiceDef,
  UatConfig,
} from './types.js';

/** A port slot. `default` is the baseline / non-hot value. */
export function slot(name: string, env: string, defaultPort: number): PortSlot {
  return { name, env, default: defaultPort };
}

/** The conventional single HTTP slot most fixtures want. */
export function httpSlot(defaultPort = 3000): PortSlot {
  return slot('http', 'PORT', defaultPort);
}

/** One `dependsOn` edge: `target`'s `port` slot rendered into `bind` env vars. */
export function dependsOn(target: string, port: string, bind: BindVar[]): DependsOn {
  return { target, port, bind };
}

/**
 * The runnable relation. Defaults describe the simplest runnable unit: one start
 * command, one HTTP port, no dependencies.
 */
export function svc(over: Partial<ServiceDef> = {}): ServiceDef {
  return {
    start: 'npm run dev',
    ports: [httpSlot()],
    dependsOn: [],
    ...over,
  };
}

/**
 * A repository. Defaults to NON-RUNNABLE — pass `service: svc()` to make it
 * runnable. That default is deliberate: it makes the non-runnable case the easy
 * one to write, so tests reach for it rather than defaulting every fixture to a
 * process that has to exist.
 *
 * `enabled` is deliberately left unset — every runtime check reads
 * `repo.enabled !== false` (the convention `validateRepository` defaults to), so
 * an unset fixture reads as enabled and pre-existing tests keep their meaning.
 * Pass `{ enabled: false }` to build a DRAFT repository.
 */
export function repo(over: Partial<RepositoryDef> = {}): RepositoryDef {
  return {
    repoPath: '/repo',
    hasMigrations: false,
    ...over,
  };
}

/** Shorthand for the common "repository that runs something" fixture. */
export function runnableRepo(
  service: Partial<ServiceDef> = {},
  over: Partial<RepositoryDef> = {},
): RepositoryDef {
  return repo({ ...over, service: svc(service) });
}

/**
 * A whole manifest. `repositories` is required because it is what a test is
 * nearly always varying; everything else defaults and is overridable via `over`.
 */
export function manifest(
  repositories: Record<string, RepositoryDef>,
  over: Partial<Manifest> = {},
): Manifest {
  return {
    host: 'localhost',
    portRange: [4000, 4999],
    baselineBranch: 'develop',
    repositories,
    ...over,
  };
}

/** A uat block. Defaults match `validateUat({})` so tests start from the real default. */
export function uat(over: Partial<UatConfig> = {}): UatConfig {
  return {
    maxFixAttempts: 3,
    env: {},
    secrets: [],
    passthrough: [],
    origins: [],
    repositories: {},
    ...over,
  };
}

/** A review block. Defaults match `validateReview({}, [])` so tests start from the real default. */
export function review(over: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    maxFixAttempts: 3,
    requireIndependentSignal: true,
    openChanges: false,
    findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
    repositories: {},
    ...over,
  };
}

/** A processes block. Defaults match `validateProcessAssignments({}, {})` so tests start from the real default. */
export function processes(
  over: Partial<ProcessAssignmentsConfig> = {},
): ProcessAssignmentsConfig {
  return {
    uatTester: { provider: 'codex', model: 'gpt-5.6-sol', enabled: true },
    ...over,
  };
}

/**
 * A fully-populated nested `graph:` block, matching the design Configuration
 * Model. `validateGraphConfig` accepts the typed shape (every field present),
 * so hand-built fixtures can spread this and override one field.
 */
export function graphApproachConfig(over: Partial<GraphApproachConfig> = {}): GraphApproachConfig {
  return {
    planner: { profile: 'expert', prompt: { artifact: 'skills/graph-planner/SKILL.md' } },
    profiles: {
      expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
      fast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    },
    commands: {
      test: {
        command: 'npm',
        args: ['test'],
        cwd: 'repository',
        access: 'write',
        timeoutSeconds: 1800,
      },
    },
    limits: {
      confirmGeneratedGraph: true,
      maxParallel: 1,
      maxNodeRuns: 40,
      maxExpertRuns: 5,
      maxReplans: 2,
      maxActivations: 200,
      maxGraphWallSeconds: 86400,
      maxAgentWallSeconds: 7200,
      maxAgentIdleSeconds: 1800,
      maxArtifactBytes: 104857600,
      maxLogBytes: 10485760,
      maxAggregateArtifactBytes: 536870912,
      maxAggregateWorkspaceBytes: 21474836480,
    },
    ...over,
  };
}

/** One approach entry carrying the full graph block (disabled by default). */
export function graphApproach(over: Partial<ApproachDef> = {}): ApproachDef {
  return {
    id: 'karst-graph-engineering',
    label: 'Graph Engineering',
    enabled: false,
    graph: graphApproachConfig(),
    ...over,
  };
}

/**
 * The canonical two-service stack: `frontend` depends on `backend`'s http port
 * and binds it into `VITE_API_URL`. This exact pair is what the resolver, spin,
 * and preflight suites all need — it exercises the dependsOn/bind path, which is
 * the resolver's silent-failure surface.
 */
export function stack(over: { backendRepo?: string; frontendRepo?: string } = {}): Record<
  string,
  RepositoryDef
> {
  return {
    backend: runnableRepo(
      { health: 'http://{host}:{port}/health', ports: [httpSlot(3000)] },
      { repoPath: over.backendRepo ?? '/repo/backend' },
    ),
    frontend: runnableRepo(
      {
        ports: [httpSlot(5173)],
        dependsOn: [
          dependsOn('backend', 'http', [
            { env: 'VITE_API_URL', template: 'http://{host}:{port}' },
          ]),
        ],
      },
      { repoPath: over.frontendRepo ?? '/repo/frontend' },
    ),
  };
}
