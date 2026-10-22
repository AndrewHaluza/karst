import type { StageKey } from '../model/types.js';
import type { StagePatch } from '../store/stages.js';
import type { RecoveryTriggerKind } from '../store/recoveryRoundsRead.js';

export const FIXTURE_NAMES = ['empty', 'ticket-mid-stage', 'blocked'] as const;
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
export interface TicketSeed {
  key: string;
  title: string;
  stageCurrent: StageKey;
  stages: StageSeed[];
  archived?: boolean;
  /** Give the ticket a worktree row (the checkout itself is not created). */
  worktree?: boolean;
  rows?: Partial<RowSeeds>;
}
export interface FixtureSpec {
  name: string;
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
