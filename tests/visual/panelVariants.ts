/**
 * T1063: the Servers, Worktrees and Pull requests panel states (ui:UI-R57), each at wide, mid and narrow.
 * Screenshot-only (`skipLayout`): the layout gate already opens the populated dashboard route.
 */
import type { Reason } from '../../src/model/prMergeReadiness.js';
import type { PrPanelRow } from '../../src/model/prPanelView.js';
import type { DashboardState } from '../../src/ui/dashboard/state.js';
import { sharedServerFixtures } from '../../src/ui/dashboard/renderFixtures.js';

export interface PanelVariantSpec {
  readonly id: string;
  readonly patch: (s: DashboardState) => DashboardState;
  /** A selector clicked after load (opens a popover). */
  readonly click?: string;
}

export const PANEL_TIERS = [['wide', 1100], ['mid', 800], ['narrow', 400]] as const;

type Servers = NonNullable<DashboardState['servers']>;
const server = (id: number, service: string, status: string, port: number | null): Servers[number] => ({
  id,
  ticketId: 1,
  service,
  host: port === null ? null : 'localhost',
  port,
  status,
  logPath: status === 'stopped' ? null : `fixture:logs/${service}.log`,
  startedAt: '2026-07-20T12:00:05.000Z',
});

const checks = (state: 'passing' | 'failing' | 'pending', label: string): PrPanelRow['checks'] => ({
  state,
  label,
  title: `${label} (fixture)`,
  detailsLabel: '',
  failing: [],
});

const pr = (over: Partial<PrPanelRow> & Pick<PrPanelRow, 'repo' | 'repoDisplay' | 'number' | 'status'>): PrPanelRow => ({
  url: `fixture:https://github.com/fixture-org/${over.repoDisplay}/pull/${over.number}`,
  branches: 'feat/FEAT-142-base-branch-override → main',
  baseRef: 'main',
  opened: 'opened 2d ago',
  openedTitle: 'opened Aug 11, 2026, 2:04 PM',
  merged: '',
  mergedTitle: '',
  commentsLabel: '',
  comments: [],
  checks: { state: 'none', label: '', title: '', detailsLabel: '', failing: [] },
  mergeBlockLabel: '',
  canMerge: false,
  mergeBlockedReason: '',
  title: 'Let a ticket override its base branch',
  author: 'fixture-author',
  changes: { files: 6, additions: 120, deletions: 14, commits: 3 },
  review: { decision: null, approvals: 0, required: null, requested: [] },
  readiness: { ready: false, headline: 'Merge blocked', facts: '', reasons: [] },
  dismissed: false,
  dismissedLabel: '',
  canDismiss: true,
  ...over,
});


function blocked(...reasons: Reason[]): PrPanelRow['readiness'] {
  return { ready: false, headline: 'Merge blocked', facts: '', reasons };
}
const prOf = (readiness: PrPanelRow['readiness'], over: Partial<PrPanelRow> = {}): PrPanelRow =>
  pr({ repo: 'fixture:/repos/api', repoDisplay: 'api', number: 88, status: 'open', readiness, ...over });

const READY = pr({ repo: 'fixture:/repos/web', repoDisplay: 'web', number: 421, status: 'open', canMerge: true, checks: checks('passing', '3 passed'),
  readiness: { ready: true, headline: 'Ready to merge', facts: 'checks passed · no conflicts · approved', reasons: [] } });
const BLOCKED = pr({
  repo: 'fixture:/repos/api', repoDisplay: 'api', number: 88, status: 'open', checks: checks('failing', '1 failing · 2 passed'),
  mergeBlockLabel: 'blocked', mergeBlockedReason: 'Required reviews are missing.',
  readiness: blocked(
    { kind: 'checks', state: 'bad', label: 'Checks failing', short: 'checks failing · 1', detail: '1 failing · 2 passed', action: { act: 'send-ci-failure', label: 'Send CI failure to agent' } },
    { kind: 'review', state: 'warn', label: 'Awaiting review', short: 'awaiting review', detail: 'no approvals yet', action: { act: 'open-pr', label: 'Open on GitHub', url: 'fixture:https://github.com/fixture-org/api/pull/88' } },
  ),
});
const READY_OPTIONAL_FAILING = pr({
  repo: 'fixture:/repos/api', repoDisplay: 'api', number: 90, status: 'open', canMerge: true, checks: checks('failing', '1 failing · 3 passed'),
  readiness: {
    ready: true, headline: 'Ready to merge', facts: 'checks passed · no conflicts · approved',
    reasons: [{ kind: 'checks', state: 'note', label: 'Optional checks failing', short: 'optional checks failing · 1', detail: '1 optional check failing',
      action: { act: 'send-ci-failure', label: 'Send CI failure to agent' }, list: [{ text: 'lint' }] }],
  },
});
const MERGED = pr({
  repo: 'fixture:/repos/web', repoDisplay: 'web', number: 421, status: 'merged', canDismiss: false,
  merged: 'merged 1h ago', mergedTitle: 'merged Aug 13, 2026, 9:00 AM',
});
const DISMISSED = pr({
  repo: 'fixture:/repos/docs', repoDisplay: 'docs', number: 12, status: 'closed', dismissed: true,
  dismissedLabel: 'dismissed 3h ago', canDismiss: false,
});

const CHECKS_FAIL: Reason = { kind: 'checks', state: 'bad', label: 'Checks failing', short: 'checks failing · 2', detail: '1 failing · 2 passed', action: { act: 'send-ci-failure', label: 'Send CI failure to agent' } };
const RULE = prOf(blocked({ kind: 'github-rule', state: 'warn', label: 'Blocked by a GitHub rule', short: 'GitHub rule', detail: 'GitHub refuses the merge; karst cannot see which rule', action: { act: 'open-pr', label: 'Open on GitHub', url: 'fixture:https://github.com/fixture-org/api/pull/88' } }));
const UNKNOWN = prOf(blocked({ kind: 'checks', state: 'run', label: 'Checks unknown', short: 'checks unknown', detail: 'karst has not read the checks yet', why: 'The last probe did not state the checks.', disclosure: 'why karst cannot tell' }));
const CONFLICTS: Reason = {
  kind: 'conflicts', state: 'warn', label: 'Conflicts with main', short: 'conflicts · 3 files', detail: '3 files · checked just now',
  action: { act: 'resolve-conflicts', label: 'Resolve', repo: 'fixture:/repos/api' },
  list: [{ text: 'src/ui/usage/__snapshots__/render.test.ts.snap' }, { text: 'src/model/prChecks.ts' }, { text: 'tests/visual/layout-known-failures.json' }],
};
const CHECKS_LIST: Reason = { ...CHECKS_FAIL, list: [{ text: 'Typecheck, build, unit' }, { text: 'Visual regression (blocks new breaks)' }] };
const BLOCKED_2 = prOf(blocked(CHECKS_LIST, CONFLICTS));
const BLOCKED_1 = prOf(blocked(CHECKS_LIST));
const FIX_RUNNING_2 = prOf(blocked({ ...CHECKS_LIST, state: 'run', short: 'auto-fix round 1 runs', detail: 'Auto-fix round 1 runs', action: undefined }, CONFLICTS));
const FIX_RUNNING = prOf(blocked({ ...CHECKS_FAIL, state: 'run', short: 'auto-fix round 1 runs', detail: 'auto-fix round 1 is running', action: undefined }));
const FIX_PARKED = prOf(blocked({ ...CHECKS_FAIL, extra: 'Auto-fix parked: it needs your decision.' }));

const withServers = (servers: Servers) => (s: DashboardState): DashboardState => ({ ...s, servers });
const withPrs = (prs: PrPanelRow[]) => (s: DashboardState): DashboardState => ({ ...s, prs });
const withWorktrees = (f: (w: NonNullable<DashboardState['worktrees']>) => NonNullable<DashboardState['worktrees']>) =>
  (s: DashboardState): DashboardState => ({ ...s, worktrees: f(s.worktrees ?? []) });

export const PANEL_VARIANTS: readonly PanelVariantSpec[] = [
  { id: 'srv-running', patch: withServers([server(1, 'web', 'running', 5173), server(2, 'api', 'running', 4000)]) },
  {
    id: 'srv-mixed',
    patch: (s) => ({ ...withServers([server(1, 'web', 'running', 5173), server(2, 'api', 'failed', null), server(3, 'worker', 'stopped', null)])(s), sharedServers: sharedServerFixtures() }),
  },
  { id: 'srv-fault', patch: withServers([server(1, 'web', 'failed', null), server(2, 'api', 'failed', null)]) },
  { id: 'srv-stopped', patch: withServers([server(1, 'web', 'stopped', null), server(2, 'api', 'stopped', null)]) },
  { id: 'srv-none', patch: withServers([]) },
  { id: 'wt-normal', patch: (s) => s },
  { id: 'wt-base', patch: (s) => s, click: '[data-act="toggle-base-form"]' },
  { id: 'wt-ext', patch: withWorktrees((w) => w.map((x, i) => ({ ...x, launchable: true, branch: i === 0 ? x.branch : 'feat/other-branch' }))) },
  { id: 'wt-empty', patch: withWorktrees(() => []) },
  { id: 'pr-mixed', patch: withPrs([READY, BLOCKED, DISMISSED]) },
  { id: 'pr-ready', patch: withPrs([READY]) },
  { id: 'pr-optional-failing', patch: withPrs([READY_OPTIONAL_FAILING]) },
  { id: 'pr-ready-info', patch: withPrs([READY]), click: '[data-act="toggle-pr-info"]' },
  { id: 'pr-rule', patch: withPrs([RULE]) },
  { id: 'pr-unknown', patch: withPrs([UNKNOWN]) },
  { id: 'pr-merged', patch: withPrs([MERGED]) },
  {
    id: 'pr-autofix-running',
    patch: (s) => ({ ...withPrs([READY, FIX_RUNNING])(s), autopilot: { ...(s.autopilot ?? { override: 'inherit', projectDefault: true, effective: true, banner: null }), roundRunning: true } }),
  },
  { id: 'pr-autofix-parked', patch: withPrs([READY, FIX_PARKED]) },
  { id: 'pr-blocked-2-closed', patch: withPrs([BLOCKED_2]) },
  { id: 'pr-blocked-2-open', patch: withPrs([BLOCKED_2]), click: '.prblock-fold > summary' },
  { id: 'pr-blocked-2-autofix', patch: withPrs([FIX_RUNNING_2]) },
  { id: 'pr-blocked-1', patch: withPrs([BLOCKED_1]) },
  { id: 'pr-empty', patch: withPrs([]) },
];
