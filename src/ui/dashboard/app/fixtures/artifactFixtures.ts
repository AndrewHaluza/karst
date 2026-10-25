/** Artifact summaries and stored-artifact views shared by the artifact view tests. */
import type { ArtifactSummary } from '../../../../model/artifacts.js';
import type { DashboardState } from '../../state.js';

/** Four artifacts in the host's semantic-priority order, one per producing stage. */
export function artifactFixtures(): ArtifactSummary[] {
  return [
    {
      id: 'plan', stage: 'impl', kind: 'plan', title: 'Plan', scope: null, summary: '3 tasks · 2 done · 1 in progress', status: 'info', freshness: 'current',
      origin: { kind: 'karst', core: 'codex' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: '2026-08-01T08:00:00.000Z',
      metrics: [{ label: 'to-do', value: '0' }, { label: 'in progress', value: '1' }, { label: 'done', value: '2' }],
      gates: [], findings: [], prs: [], commits: [],
      tasks: [
        { id: 'impl', label: 'Implement the feature', kind: 'agent', status: 'done', visits: 'visit 1' },
        { id: 'verify', label: 'Verify', kind: 'command', status: 'doing', visits: 'visit 1' },
        { id: 'note', label: 'Note', kind: 'join', status: 'todo', visits: null },
      ],
      resources: [], detail: null, agentConsole: null,
    },
    {
      id: 'uat-report', stage: 'uat', kind: 'uat-report', title: 'UAT report', scope: null, summary: '2 passed · 1 failed', status: 'passed', freshness: 'current',
      origin: { kind: 'karst', core: 'codex' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: '2026-08-01T10:00:00.000Z',
      metrics: [{ label: 'passed', value: '2' }, { label: 'failed', value: '1' }],
      gates: [{ name: 'lint', exitCode: 0 }, { name: 'test', exitCode: 0 }, { name: 'e2e', exitCode: 2 }, { name: 'perf', exitCode: null }],
      findings: [], prs: [], commits: [], tasks: [],
      resources: [{ name: 'uat-ticket-1.log', path: '/data/karst/artifacts/1/uat-ticket-1.log', label: 'UAT log', taskId: null }],
      detail: null, agentConsole: 'tester',
    },
    {
      id: 'review', stage: 'review', kind: 'review', title: 'Review', scope: null, summary: '1 finding · 1 needs attention', status: 'attention', freshness: 'stale',
      origin: { kind: 'karst', core: null }, versionCount: 1, currentVersionLabel: 'v1', createdAt: null,
      metrics: [{ label: 'high', value: '1' }], gates: [],
      findings: [
        { severity: 'high', title: 'Credential cache is not cleared', detail: 'The cache outlives the session.', repo: '/wt/web', file: 'src/auth.ts', line: 12, action: { actionId: 'snapshot-1:action-8', kind: 'open-file' } },
        { severity: 'low', title: 'Typo', detail: null, repo: '/wt/api', file: 'src/b.ts', line: null },
        { severity: 'info', title: 'Note', detail: null, repo: '/wt/api', file: null, line: null },
      ],
      prs: [], commits: [], tasks: [], resources: [], detail: null, agentConsole: 'review',
    },
    {
      id: 'ship-summary', stage: 'ship', kind: 'ship-summary', title: 'PR summary', scope: null, summary: '1 PR · 1 new commit', status: 'passed', freshness: 'current',
      origin: { kind: 'native', core: 'claude' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: '2026-08-01T11:00:00.000Z',
      metrics: [{ label: 'repos', value: '1' }, { label: 'PRs', value: '1' }, { label: 'new commits', value: '1' }],
      gates: [], findings: [],
      prs: [{ repo: '/wt/web', number: 42, url: 'https://github.com/o/r/pull/42', status: 'open' }],
      commits: [{ repo: '/wt/web', sha: 'abc123def', message: 'feat: passkey login', origin: 'created-by-ship', action: { actionId: 'snapshot-1:action-9', kind: 'open-commit' } }],
      tasks: [], resources: [], detail: null, agentConsole: null,
    },
  ] as unknown as ArtifactSummary[];
}

export function stateWithArtifacts(over: Record<string, unknown> = {}): DashboardState {
  return { ticketId: 7, key: 'FEAT-7', title: 'Seven', artifacts: artifactFixtures(), ...over } as unknown as DashboardState;
}

export const SHA1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const SHA2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** One captured file with two revisions, plus a skipped one. */
export const storedView = {
  total: 1,
  globs: ['plans/**'],
  skips: [{ path: 'app/.env', reason: 'secret-pattern' }],
  groups: [
    {
      kind: 'plan',
      approaches: [
        {
          approach: 'gsd',
          rows: [
            {
              path: 'app/plans/a.md', repo: 'app', relPath: 'plans/a.md', kind: 'plan', approach: 'gsd', source: 'watcher', revisions: 2,
              lastAt: '2026-01-02T00:00:00Z', latestSha: SHA2,
              history: [{ sha: SHA2, at: '2026-01-02T00:00:00Z', source: 'watcher' }, { sha: SHA1, at: '2026-01-01T00:00:00Z', source: 'hook' }],
            },
          ],
        },
      ],
    },
  ],
};
