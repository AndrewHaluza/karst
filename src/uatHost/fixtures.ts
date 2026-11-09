import type { FakeCoreScript } from '../agent/fakeCore.js';
import type { StageKey } from '../model/types.js';
import type { StagePatch } from '../store/stages.js';
import type { RecoveryTriggerKind } from '../store/recoveryRoundsRead.js';

export const FIXTURE_NAMES = ['empty', 'ticket-mid-stage', 'blocked', 'launch-draft'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function isFixtureName(s: string): s is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(s);
}

export interface StageSeed { stageKey: StageKey; patch: StagePatch }
export interface StageRunSeed { stageKey: StageKey; attempt: number; status: 'running' | 'finished'; outcome?: 'advanced' | 'blocked' | 'stopped' }
export interface ProcessRunSeed {
  stageKey: StageKey;
  processId: string;
  attempt: number;
  status: 'running' | 'passed' | 'failed' | 'interrupted';
  /** Index into this ticket's `stageRuns`; links the process run to that stage run. */
  stageRun?: number;
}
export interface GateRunSeed { stageKey: StageKey; attempt: number; gateName: string; exitCode: number | null; stageRun?: number }
export interface RecoveryRoundSeed {
  sourceStage: 'uat' | 'review' | 'ship';
  sourceProcessId: 'gates' | 'tester' | 'review' | 'pr-review';
  triggerKind: RecoveryTriggerKind;
  triggerDetail: string;
  maxRounds: number;
}
export interface PrSeed {
  repo: string;
  number: number;
  url: string;
  status: 'open' | 'draft' | 'closed' | 'merged';
  headRef?: string;
  baseRef?: string;
  mergeBlock?: 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'draft' | 'has_hooks';
}
export interface MergeCheckSeed {
  repo: string;
  state: 'clean' | 'conflicted' | 'unknown';
  files: string[];
  reason: string | null;
  headSha: string | null;
  baseSha: string | null;
  baseRef: string | null;
}
export interface ReviewFindingSeed {
  attempt: number;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  repo: string;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  source: 'agent' | 'human';
}
/** The small allow-list of tables a fixture file may fill to model stranded/recovery/engine states. */
export interface RowSeeds {
  stageRuns: StageRunSeed[];
  processRuns: ProcessRunSeed[];
  gateRuns: GateRunSeed[];
  recoveryRounds: RecoveryRoundSeed[];
  prs: PrSeed[];
  mergeChecks: MergeCheckSeed[];
  reviewFindings: ReviewFindingSeed[];
}
/** Where a seeded ticket's worktree row points; replaces the old fixed `/fixture/repo`. */
export interface RepoBinding { repoPath: string; baseRef: string; worktreePath: string }
export interface TicketSeed {
  key: string;
  title: string;
  /** The ticket brief (what the agent is asked to do). */
  description?: string;
  /** Overrides the default worktree row for `worktree: true`. */
  repo?: RepoBinding;
  stageCurrent: StageKey;
  /** Manifest repo names; a draft with none cannot open a session. */
  selectedRepos?: string[];
  stages: StageSeed[];
  archived?: boolean;
  /** Give the ticket a worktree row (the checkout itself is not created). */
  worktree?: boolean;
  /** Record the ticket's placement. Autopilot parks a ticket with no placement ('placement unknown'). Only `host` runs in the container. */
  placement?: 'host';
  rows?: Partial<RowSeeds>;
}
/** A gate in the scratch manifest: argv-based, no shell. Only these two names are allowed. */
export interface TaskGate { name: 'test' | 'typecheck'; command: string; args: string[] }
/** The optional `autopilot:` block of the scratch manifest; omitted keys take the manifest defaults. */
export interface AutopilotSeed {
  enabled: boolean;
  ci?: { policy?: 'auto' | 'ask'; maxAttempts?: number; checks?: string[] };
  conflicts?: { policy?: 'auto' | 'ask'; maxRounds?: number };
}
/** The external task repo the scratch karst.yml points at (eval runs). */
export interface TaskRepo { name: string; repoPath: string; baseRef: string; gates: TaskGate[] }
export interface FixtureSpec {
  name: string;
  /** When set, the workspace manifest declares this repo and its gates instead of the stock `app`. */
  taskRepo?: TaskRepo;
  tickets: TicketSeed[];
  /** Manifest `agentProvider`; defaults to claude. */
  provider?: string;
  /** Written into the scratch manifest as `autopilot:` (JSON is YAML flow). */
  autopilot?: AutopilotSeed;
  /** Scripted headless answers for the fake core (played only under `KARST_FAKE_CORE=1`). */
  fakeCore?: FakeCoreScript;
}

const STARTED = '2026-01-01T00:00:00.000Z';

const SPECS: Record<FixtureName, TicketSeed[]> = {
  empty: [],
  'ticket-mid-stage': [
    {
      key: 'FIX-MID',
      title: 'Fixture: ticket mid-stage',
      stageCurrent: 'impl',
      stages: [{ stageKey: 'impl', patch: { status: 'running', startedAt: STARTED } }],
    },
  ],
  // A never-started draft with its repo selected: karst.openSession scopes it
  // (worktree + impl) and then launches, which `KARST_FAKE_CORE=launch` records.
  'launch-draft': [
    { key: 'FIX-LAUNCH', title: 'Fixture: launch-ready draft', stageCurrent: 'scope', selectedRepos: ['app'], stages: [] },
  ],
  blocked: [
    {
      key: 'FIX-BLOCKED',
      title: 'Fixture: blocked ticket',
      stageCurrent: 'uat',
      stages: [{
        stageKey: 'uat',
        patch: {
          status: 'running',
          startedAt: STARTED,
          blockedKind: 'boot-failed',
          blockedReason: 'fixture: services failed to start',
        },
      }],
    },
  ],
};

export function fixtureSpec(name: FixtureName): FixtureSpec {
  return { name, tickets: SPECS[name] };
}

const yamlStr = (v: string): string => JSON.stringify(v);

function autopilotLines(autopilot?: AutopilotSeed): string[] {
  return autopilot ? [`autopilot: ${JSON.stringify(autopilot)}`] : [];
}

/** Scratch manifest for an eval run: one repo at `repoPath`, only the declared gates (JSON is YAML flow). */
export function taskManifestText(task: TaskRepo, provider = 'claude', autopilot?: AutopilotSeed): string {
  const lines = [
    'host: 127.0.0.1',
    'portRange: [4000, 4100]',
    `baselineBranch: ${yamlStr(task.baseRef)}`,
    `agentProvider: ${provider}`,
    'repositories:',
    `  ${task.name}:`,
    `    repoPath: ${yamlStr(task.repoPath)}`,
    '    hasMigrations: false',
    `    signals: [${task.name}]`,
  ];
  if (task.gates.length > 0) {
    lines.push('uat:', '  gates:');
    for (const g of task.gates) {
      lines.push(`    - ${JSON.stringify({ name: g.name, kind: 'command', command: g.command, args: g.args })}`);
    }
  }
  return [...lines, ...autopilotLines(autopilot), ''].join('\n');
}

/** A command gate that always passes: the harness checks the UI and the fake core, not a real test run. */
const NOOP_GATE = JSON.stringify({ name: 'noop', kind: 'command', command: 'node', args: ['-e', '0'] });

export function manifestText(repoPath: string, provider = 'claude', autopilot?: AutopilotSeed): string {
  return [
    'host: 127.0.0.1',
    'portRange: [4000, 4100]',
    'baselineBranch: main',
    `agentProvider: ${provider}`,
    'repositories:',
    '  app:',
    `    repoPath: ${repoPath}`,
    '    hasMigrations: false',
    '    signals: [app]',
    // The scratch repo has no package.json, so without a declared gate review and uat block at `nothing-to-run`.
    ...['review', 'uat'].flatMap((stage) => [`${stage}:`, '  gates:', `    - ${NOOP_GATE}`]),
    ...autopilotLines(autopilot),
    '',
  ].join('\n');
}
