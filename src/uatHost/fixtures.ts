import type { StageKey } from '../model/types.js';
import type { StagePatch } from '../store/stages.js';

export const FIXTURE_NAMES = ['empty', 'ticket-mid-stage', 'blocked', 'launch-draft'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function isFixtureName(s: string): s is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(s);
}

export interface TicketSeed {
  key: string;
  title: string;
  stageCurrent: StageKey;
  /** Manifest repo names; a draft with none cannot open a session. */
  selectedRepos?: string[];
  stage?: { stageKey: StageKey; patch: StagePatch };
}
export interface FixtureSpec {
  name: FixtureName;
  tickets: TicketSeed[];
}

const STARTED = '2026-01-01T00:00:00.000Z';

const SPECS: Record<FixtureName, TicketSeed[]> = {
  empty: [],
  'ticket-mid-stage': [
    {
      key: 'FIX-MID',
      title: 'Fixture: ticket mid-stage',
      stageCurrent: 'impl',
      stage: { stageKey: 'impl', patch: { status: 'running', startedAt: STARTED } },
    },
  ],
  // A never-started draft with its repo selected: karst.openSession scopes it
  // (worktree + impl) and then launches, which `KARST_FAKE_CORE=launch` records.
  'launch-draft': [
    { key: 'FIX-LAUNCH', title: 'Fixture: launch-ready draft', stageCurrent: 'scope', selectedRepos: ['app'] },
  ],
  blocked: [
    {
      key: 'FIX-BLOCKED',
      title: 'Fixture: blocked ticket',
      stageCurrent: 'uat',
      stage: {
        stageKey: 'uat',
        patch: {
          status: 'running',
          startedAt: STARTED,
          blockedKind: 'boot-failed',
          blockedReason: 'fixture: services failed to start',
        },
      },
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
