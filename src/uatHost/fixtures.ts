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
/** The small allow-list of tables a fixture file may fill to model stranded/recovery states. */
export interface RowSeeds {
  stageRuns: StageRunSeed[];
  processRuns: ProcessRunSeed[];
  gateRuns: GateRunSeed[];
  recoveryRounds: RecoveryRoundSeed[];
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
  rows?: Partial<RowSeeds>;
}
/** A gate in the scratch manifest: argv-based, no shell. Only these two names are allowed. */
export interface TaskGate { name: 'test' | 'typecheck'; command: string; args: string[] }
/** The external task repo the scratch karst.yml points at (eval runs). */
export interface TaskRepo { name: string; repoPath: string; baseRef: string; gates: TaskGate[] }
export interface FixtureSpec {
  name: string;
  /** When set, the workspace manifest declares this repo and its gates instead of the stock `app`. */
  taskRepo?: TaskRepo;
  tickets: TicketSeed[];
  /** Manifest `agentProvider`; defaults to claude. */
  provider?: string;
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

/** Scratch manifest for an eval run: one repo at `repoPath`, only the declared gates (JSON is YAML flow). */
export function taskManifestText(task: TaskRepo, provider = 'claude'): string {
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
  return [...lines, ''].join('\n');
}

export function manifestText(repoPath: string, provider = 'claude'): string {
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
    '',
  ].join('\n');
}
