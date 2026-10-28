// @vitest-environment jsdom
/**
 * Dashboard parity oracle — every posting control (migration plan §3 A2, §5 Phase 1).
 *
 * Behavioural, not structural: each case builds a host state in which one
 * `[data-act]` control renders, clicks it through the DOM, and asserts the
 * EXACT messages posted to the host (type + payload, `requestId` present or
 * absent) plus the pending contract (aria-busy after the click, a repeat click
 * posts nothing). It must pass unchanged on the vanilla `webview.html` and on
 * its React replacement, so the only thing read from the HTML source is the key
 * list the coverage guard compares against.
 *
 * Adding an act to `SEND_BY_ACT` (or a special-cased `act === '…'` branch)
 * without a case below, or an entry in `NOT_COVERED`, fails the guard.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import { RUNTIME_ASSETS_ROOT } from '../../../runtimeAssetsRoot.js';
import { populatedStateFor, shipPreviewStateFor, sharedServerFixtures } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { buildStageRail } from '../../../model/stageRail.js';

type Stage = Parameters<typeof populatedStateFor>[0];

const REPO = 'fixture:/repos/web';
const WT_PATH = 'fixture:/worktrees/FEAT-142/web';
const PR_URL = 'fixture:https://github.com/fixture-org/web/pull/421';

const st = (stage: Stage, over: Record<string, unknown> = {}): DashboardState =>
  ({ ...populatedStateFor(stage), ...over }) as DashboardState;

const pr = (over: Record<string, unknown>) => {
  const [base] = populatedStateFor('ship').prs;
  return { ...base!, ...over };
};

/** Every server row stopped except the first, so Start (row + header) renders. */
const withStoppedServer = (): DashboardState => {
  const s = populatedStateFor('impl');
  return {
    ...s,
    servers: [s.servers[0]!, { ...s.servers[1]!, status: 'stopped', host: null, port: null }],
    sharedServers: sharedServerFixtures(),
  } as DashboardState;
};

/** The stage rail's needs-you button on the current stage, carrying one call to action. */
const railNeedsState = (stage: Stage, cta: Record<string, unknown>): DashboardState => {
  const s = populatedStateFor(stage);
  const rail = buildStageRail(s.stepper, s.stepper, {
    current: stage,
    needsUser: true,
    needs: { detail: 'needs you', action: 'Do it', cta },
  } as unknown as Parameters<typeof buildStageRail>[2]);
  return { ...s, rail } as DashboardState;
};

const shipMenuState = (): DashboardState =>
  st('ship', {
    sendBack: { available: true, stage: 'ship' },
    prFeedbackFix: { available: true, round: 1, items: 2 },
    ciFailure: { available: true, repos: [REPO] },
    rebase: { available: true, stage: 'ship' },
    deliver: { available: true, notOnPr: 2, inSandbox: 1 },
  });

const uatMenuState = (): DashboardState =>
  st('uat', {
    sendBack: { available: true, stage: 'uat' },
    rerunGate: { available: true, stage: 'uat' },
    resetStage: { available: true, stage: 'uat' },
  });

const blockedState = (kind: string, resumable: boolean): DashboardState => {
  const s = populatedStateFor('uat');
  const cell = s.stepper.find((c) => c.stageKey === 'uat')!;
  return {
    ...s,
    currentStage: { ...cell, blocked: { kind, reason: 'quota exhausted', at: '2026-08-12T10:00:00.000Z', resumable } },
  } as DashboardState;
};

const baselineRows = (decision: 'pending' | 'approved' = 'pending') =>
  [0, 1].map((index) => ({
    index,
    path: `shots/a${index}.png`,
    label: `a${index}.png`,
    status: 'modified',
    oldSrc: 'https://img.test/old.png',
    newSrc: 'https://img.test/new.png',
    decision,
    reason: null,
  }));
const baselineState = (): DashboardState =>
  ({ ...blockedState('baseline-review', false), baselineReview: baselineRows() }) as DashboardState;

const storedState = (): DashboardState =>
  st('impl', {
    storedArtifacts: {
      total: 1,
      globs: ['docs/**'],
      skips: [],
      groups: [
        {
          kind: 'doc',
          approaches: [
            {
              approach: 'direct',
              rows: [
                {
                  path: 'web/docs/a.md',
                  repo: 'web',
                  relPath: 'docs/a.md',
                  kind: 'doc',
                  approach: 'direct',
                  source: 'agent',
                  revisions: 2,
                  lastAt: '2026-08-12T10:00:00.000Z',
                  latestSha: 'sha-new',
                  history: [
                    { sha: 'sha-new', at: '2026-08-12T10:00:00.000Z', source: 'agent' },
                    { sha: 'sha-old', at: '2026-08-11T10:00:00.000Z', source: 'agent' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });

const artifactState = (): DashboardState =>
  st('impl', {
    artifacts: [
      {
        id: 'uat-report', stage: 'uat', kind: 'uat-report', title: 'UAT report', scope: null,
        summary: '2 passed', status: 'passed', freshness: 'current', origin: { kind: 'karst', core: 'codex' },
        versionCount: 1, currentVersionLabel: 'v1', createdAt: '2026-08-01T10:00:00.000Z',
        metrics: [], gates: [], findings: [], prs: [], commits: [], tasks: [],
        resources: [
          { name: 'a.log', path: '/data/a.log', label: 'A log', taskId: null },
          { name: 'b.log', path: '/data/b.log', label: 'B log', taskId: null },
        ],
        detail: null, agentConsole: null,
      },
    ],
  });

/** The Implementation view with the graph process's node ledger AND a DAG, so the Graph view toggle renders. */
const graphState = (): DashboardState => {
  const s = populatedStateFor('impl');
  const view = s.insideViews.impl;
  const evidence = {
    kind: 'rows',
    rows: [],
    nodes: [
      { entry: 'node', nodeRunId: 1, nodeId: 'build', nodeKind: 'agent', status: 'running', displayStatus: 'run', identity: 'codex' },
    ],
    dag: { columns: [[{ id: 'build', label: 'build', displayStatus: 'run', state: 'running' }]] },
  };
  const processes = [{ ...view.processes[0]!, evidence }, ...view.processes.slice(1)];
  return { ...s, insideViews: { ...s.insideViews, impl: { ...view, processes } } } as unknown as DashboardState;
};

/** An artifact whose findings span two repos, so the detail view offers the repo scope chips. */
const artifactFindingsState = (): DashboardState => {
  const s = artifactState();
  const finding = (repo: string) => ({ severity: 'high', title: `in ${repo}`, detail: 'd', repo, file: 'a.ts', line: 1, action: { actionId: `fixture:open-file:${repo}`, kind: 'open-file' } });
  const [a] = s.artifacts;
  return { ...s, artifacts: [{ ...a!, findings: [finding('/wt/web'), finding('/wt/api')] }] } as unknown as DashboardState;
};

/** The Review view with two attempt tabs (the round switcher). */
const attemptsState = (): DashboardState => {
  const s = populatedStateFor('review');
  const view = s.insideViews.review;
  return {
    ...s,
    insideViews: {
      ...s.insideViews,
      review: {
        ...view,
        attempts: [
          { key: 'r1', label: 'R1', status: 'failed', statusLabel: 'failed', latest: false },
          { key: 'r2', label: 'R2', status: 'passed', statusLabel: 'passed', latest: true },
        ],
        selectedAttempt: 'r2',
      },
    },
  } as unknown as DashboardState;
};

/** A findings body scoped over two repos (the findings repo chips). */
const findingsFilterState = (): DashboardState => {
  const s = populatedStateFor('review');
  const view = s.insideViews.review;
  const processes = view.processes.map((p: any) =>
    p.evidence?.kind === 'findings'
      ? { ...p, repoFilter: { repos: ['fixture:/repos/web', 'fixture:/repos/api'], selected: null } }
      : p,
  );
  return { ...s, insideViews: { ...s.insideViews, review: { ...view, processes } } } as unknown as DashboardState;
};

// ---- case machinery -------------------------------------------------------

interface ParityCase {
  /** `data-act` this case covers (the guard key). */
  act: string;
  /** Distinguishes several cases of one act (different surface / state). */
  variant?: string;
  state: () => DashboardState;
  /** Idempotent: navigates / opens whatever makes `sel` render. Also re-run before the repeat click. */
  prep?: (h: RenderHandle) => void | Promise<void>;
  sel: string;
  /** Messages the click must post, in order. `[]` = posts nothing by design. */
  posts: Array<Record<string, unknown>>;
  /** Does the wire carry a `requestId`? Long-runners settle on a state push and carry none. */
  rid?: boolean;
  /** Where the pending marker lands after the click (default: `sel`); `false` = no pending contract. */
  pendingSel?: string | false;
  /** Extra DOM assertions after the click, for controls whose only effect is local view state. */
  after?: (h: RenderHandle) => void;
  /** Re-open the control after the click and assert a second click posts nothing. */
  repeat?: boolean;
}

const q = (h: RenderHandle, sel: string): HTMLElement | null => h.query<HTMLElement>(sel);
const clickEl = (el: HTMLElement): void => {
  el.dispatchEvent(new el.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true }));
};
/** jsdom has no `CSS`; VS Code's webview does and the page calls `CSS.escape`. */
const polyfillCss = (h: RenderHandle): void => {
  (h.window as unknown as { CSS: { escape(s: string): string } }).CSS = {
    escape: (v: string) => v.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => `\\${ch}`),
  };
};
const isShown = (el: Element): boolean => !el.closest('[hidden], .hidden');

/** Open the current stage header's ⋯ menu when its items are not rendered. */
const ensureMenu = (stage: string, item: string) => (h: RenderHandle) => {
  if (!q(h, item)) clickEl(q(h, `[data-stage-menu="${stage}"]`)!);
};
const ensureClick = (trigger: string, target: string) => (h: RenderHandle) => {
  if (!q(h, target)) clickEl(q(h, trigger)!);
};

/** The ticket-controls (⋯) popover in the header: open it when its items are hidden. */
const headerMenu = (item: string) => (h: RenderHandle) => {
  if (q(h, item) && !isShown(q(h, item)!)) clickEl(q(h, '#moreBtn')!);
};

const act = (a: string, extra = ''): string => `[data-act="${a}"]${extra}`;
const forRepo = (a: string): string => act(a, `[data-repo="${REPO}"]`);

export const COVERED: readonly ParityCase[] = [
  // --- header --------------------------------------------------------------
  { act: 'copy-ticket-key', state: () => st('impl'), sel: act('copy-ticket-key'), posts: [{ type: 'copy-ticket-key' }], rid: true },
  {
    act: 'open-ticket-link', state: () => st('impl', { ticketUrl: 'https://tickets.example/FEAT-142' }),
    sel: act('open-ticket-link'), posts: [{ type: 'open-ticket-link', url: 'https://tickets.example/FEAT-142' }], rid: true,
  },
  { act: 'edit-ticket', state: () => st('impl'), prep: headerMenu(act('edit-ticket')), sel: act('edit-ticket'), posts: [{ type: 'edit-ticket' }], rid: true },
  { act: 'pause-execution', state: () => st('impl', { paused: false }), prep: headerMenu(act('pause-execution')), sel: act('pause-execution'), posts: [{ type: 'pause-execution' }], rid: true },
  {
    act: 'unpause-execution', variant: 'menu item', state: () => st('impl', { paused: true, pausedAt: '2026-08-12T10:00:00.000Z' }),
    prep: headerMenu('#resumeItem'), sel: '#resumeItem' + act('unpause-execution'), posts: [{ type: 'unpause-execution' }], rid: true,
  },
  {
    act: 'unpause-execution', variant: 'paused chip', state: () => st('impl', { paused: true, pausedAt: '2026-08-12T10:00:00.000Z' }),
    sel: '#pauseWait ' + act('unpause-execution'), posts: [{ type: 'unpause-execution' }], rid: true,
  },
  { act: 'create-follow-up-ticket', state: () => st('done'), prep: headerMenu(act('create-follow-up-ticket')), sel: act('create-follow-up-ticket'), posts: [{ type: 'create-follow-up-ticket' }], rid: true },
  { act: 'create-subtask', state: () => st('impl', { canAddSubtask: true }), sel: act('create-subtask'), posts: [{ type: 'create-subtask' }], rid: true },
  { act: 'detach-subtask', state: () => st('impl', { canDetachSubtask: true }), prep: headerMenu(act('detach-subtask')), sel: act('detach-subtask'), posts: [{ type: 'detach-subtask' }], rid: true },
  { act: 'close-ticket', state: () => st('impl', { canClose: true }), prep: headerMenu(act('close-ticket')), sel: act('close-ticket'), posts: [{ type: 'close-ticket' }], rid: true },
  { act: 'reopen-ticket', state: () => st('impl', { canReopen: true }), prep: headerMenu(act('reopen-ticket')), sel: act('reopen-ticket'), posts: [{ type: 'reopen-ticket' }], rid: true },
  {
    act: 'open-dependency', state: () => st('impl', { blockers: [{ ticketId: 42, idLabel: 'T42', label: 'CU-123' }] }),
    sel: act('open-dependency'), posts: [{ type: 'open-dependency', ticketId: 42 }], rid: true,
  },
  { act: 'preview-ticket-data', state: () => st('impl'), sel: act('preview-ticket-data'), posts: [], pendingSel: false },
  {
    act: 'refresh-ship-preview', state: () => shipPreviewStateFor('ready'), sel: act('refresh-ship-preview'),
    posts: [{ type: 'refresh-ship-preview' }], rid: false, pendingSel: act('refresh-ship-preview', '[aria-busy="true"]'),
  },

  {
    act: 'ship-ticket', variant: 'rail needs-you', state: () => railNeedsState('ship', { kind: 'ship-confirm' }), sel: '.go' + act('ship-ticket'),
    posts: [{ type: 'ship-ticket' }], rid: false, pendingSel: '.go[aria-busy="true"]',
  },
  {
    act: 'merge-pr', variant: 'rail needs-you', state: () => railNeedsState('ship', { kind: 'merge', repo: REPO }), sel: '.go' + forRepo('merge-pr'),
    posts: [{ type: 'merge-pr', repo: REPO }], rid: false, pendingSel: '.go[aria-busy="true"]',
  },
  {
    act: 'resolve-conflicts', variant: 'rail needs-you', state: () => railNeedsState('ship', { kind: 'resolve-conflicts', repo: REPO }),
    sel: '.go' + forRepo('resolve-conflicts'), posts: [{ type: 'resolve-conflicts', repo: REPO }], rid: true,
  },

  // --- servers -------------------------------------------------------------
  { act: 'open-server', state: () => st('impl'), sel: act('open-server', '[data-id="1"]'), posts: [{ type: 'open-server', serverId: 1 }], rid: true },
  { act: 'copy-server-url', state: () => st('impl'), sel: act('copy-server-url', '[data-id="1"]'), posts: [{ type: 'copy-server-url', serverId: 1 }], rid: true },
  { act: 'restart-server', state: () => st('impl'), sel: act('restart-server', '[data-id="1"]'), posts: [{ type: 'restart-server', serverId: 1 }], rid: true },
  { act: 'stop-server', state: () => st('impl'), sel: act('stop-server', '[data-id="1"]'), posts: [{ type: 'stop-server', serverId: 1 }], rid: true },
  { act: 'start-server', state: withStoppedServer, sel: act('start-server', '[data-id="2"]'), posts: [{ type: 'start-server', serverId: 2 }], rid: true },
  { act: 'spin-servers', state: withStoppedServer, sel: act('spin-servers'), posts: [{ type: 'spin-servers' }], rid: true },
  { act: 'restart-servers', state: () => st('impl'), sel: act('restart-servers'), posts: [{ type: 'restart-servers' }], rid: true },
  { act: 'stop-servers', state: () => st('impl'), sel: act('stop-servers'), posts: [{ type: 'stop-servers' }], rid: true },
  { act: 'open-resources', state: withStoppedServer, sel: act('open-resources'), posts: [{ type: 'open-resources' }], rid: true },
  { act: 'env-overrides-open', state: () => st('impl'), sel: act('env-overrides-open'), posts: [], pendingSel: false },
  {
    act: 'server-logs-request', state: () => st('impl'), sel: act('server-logs-request'),
    posts: [{ type: 'server-logs-request' }], rid: false, pendingSel: false,
  },

  // --- worktrees -----------------------------------------------------------
  { act: 'show-changes', state: () => st('impl'), sel: act('show-changes'), posts: [{ type: 'show-changes' }], rid: true },
  { act: 'open-worktree-terminal', state: () => st('impl'), sel: act('open-worktree-terminal', `[data-path="${WT_PATH}"]`), posts: [{ type: 'open-worktree-terminal', path: WT_PATH }], rid: true },
  { act: 'open-worktree-folder', state: () => st('impl'), sel: act('open-worktree-folder', `[data-path="${WT_PATH}"]`), posts: [{ type: 'open-worktree-folder', path: WT_PATH }], rid: true },
  {
    act: 'copy-worktree-branch', state: () => st('impl'), sel: act('copy-worktree-branch', `[data-branch="feat/FEAT-142-base-branch-override"]`),
    posts: [{ type: 'copy-worktree-branch', branch: 'feat/FEAT-142-base-branch-override' }], rid: true,
  },
  {
    act: 'launch-worktree-extension',
    state: () => { const s = populatedStateFor('impl'); return { ...s, worktrees: s.worktrees.map((w) => ({ ...w, launchable: true })) } as DashboardState; },
    sel: act('launch-worktree-extension', `[data-path="${WT_PATH}"]`), posts: [{ type: 'launch-worktree-extension', path: WT_PATH }], rid: true,
  },
  { act: 'toggle-base-form', state: () => st('impl'), sel: forRepo('toggle-base-form'), posts: [], pendingSel: false },
  {
    act: 'toggle-rebase-switch', state: () => st('impl'), prep: ensureClick(forRepo('toggle-base-form'), forRepo('toggle-rebase-switch')),
    sel: forRepo('toggle-rebase-switch'), posts: [], pendingSel: false,
  },
  {
    act: 'change-base-ref', state: () => st('impl'),
    prep: (h) => {
      ensureClick(forRepo('toggle-base-form'), forRepo('change-base-ref'))(h);
      const input = h.query<HTMLInputElement>(`[data-base-input="${REPO}"]`)!;
      input.value = 'origin/develop';
      input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    },
    sel: forRepo('change-base-ref'), posts: [{ type: 'change-base-ref', repo: REPO, baseRef: 'origin/develop', rebase: true }], rid: true,
  },
  { act: 'open-pr', variant: 'PR number', state: () => st('impl'), sel: act('open-pr', `[data-url="${PR_URL}"]`), posts: [{ type: 'open-pr', url: PR_URL }], rid: true },
  { act: 'copy-pr-url', state: () => st('impl'), sel: act('copy-pr-url', `[data-url="${PR_URL}"]`), posts: [{ type: 'copy-pr-url', url: PR_URL }], rid: true },

  // --- pull requests -------------------------------------------------------
  {
    act: 'refresh-prs', state: () => st('impl'), sel: '#prRefresh',
    posts: [{ type: 'refresh-prs' }], rid: false, pendingSel: '#prRefresh[aria-busy="true"]',
  },
  {
    act: 'merge-pr', variant: 'PR row', state: () => st('ship', { prs: [pr({ canMerge: true, mergeBlockedReason: '' })] }),
    sel: forRepo('merge-pr') + '.mgbtn', posts: [{ type: 'merge-pr', repo: REPO }], rid: false, pendingSel: '.mgbtn[aria-busy="true"]',
  },
  {
    act: 'dismiss-pr', state: () => st('ship', { prs: [pr({ canDismiss: true, status: 'closed' })] }),
    sel: forRepo('dismiss-pr'), posts: [{ type: 'dismiss-pr', repo: REPO }], rid: false, pendingSel: '.mgbtn[aria-busy="true"]',
  },
  {
    act: 'undismiss-pr', state: () => st('ship', { prs: [pr({ dismissed: true, dismissedLabel: 'dismissed', status: 'closed' })] }),
    sel: forRepo('undismiss-pr'), posts: [{ type: 'undismiss-pr', repo: REPO }], rid: false, pendingSel: '.mgbtn[aria-busy="true"]',
  },
  {
    act: 'resolve-conflicts',
    state: () => st('ship', {
      mergeChecks: [{ repo: REPO, state: 'conflicted', headline: 'conflicted · 1 file', detailsLabel: '', files: ['a.ts'], reason: '', checkedTitle: '' }],
    }),
    sel: forRepo('resolve-conflicts'), posts: [{ type: 'resolve-conflicts', repo: REPO }], rid: true,
  },
  {
    act: 'send-ci-failure', variant: 'PR row',
    state: () => st('ship', {
      prs: [pr({ checks: { state: 'failing', label: 'failing', title: '', detailsLabel: '1 failing', failing: [{ name: 'lint', url: '' }] } })],
      ciFailure: { available: true, repos: [REPO] },
    }),
    sel: '.mgbtn' + act('send-ci-failure'), posts: [{ type: 'send-ci-failure' }], rid: false, pendingSel: '.mgbtn[aria-busy="true"]',
  },

  // --- stage ⋯ menu + inside ----------------------------------------------
  {
    act: 'send-ci-failure', variant: 'stage menu', repeat: true, state: shipMenuState, prep: ensureMenu('ship', '.menuButton' + act('send-ci-failure')),
    sel: '.menuButton' + act('send-ci-failure'), posts: [{ type: 'send-ci-failure' }], rid: false, pendingSel: false,
  },
  {
    act: 'rebase-on-base', repeat: true, state: shipMenuState, prep: ensureMenu('ship', act('rebase-on-base')),
    sel: act('rebase-on-base'), posts: [{ type: 'rebase-on-base' }], rid: false, pendingSel: false,
  },
  {
    act: 'address-pr-feedback', repeat: true, state: shipMenuState, prep: ensureMenu('ship', act('address-pr-feedback')),
    sel: act('address-pr-feedback'), posts: [{ type: 'address-pr-feedback' }], rid: false, pendingSel: false,
  },
  {
    act: 'send-back-to-implement', repeat: true, state: uatMenuState, prep: ensureMenu('uat', act('send-back-to-implement')),
    sel: act('send-back-to-implement'), posts: [{ type: 'send-back-to-implement' }], rid: false, pendingSel: false,
  },
  {
    act: 'rerun-gate', repeat: true, state: uatMenuState, prep: ensureMenu('uat', act('rerun-gate')),
    sel: act('rerun-gate'), posts: [{ type: 'rerun-gate', stage: 'uat' }], rid: false, pendingSel: false,
  },
  {
    act: 'reset-stage', repeat: true, state: uatMenuState, prep: ensureMenu('uat', act('reset-stage')),
    sel: act('reset-stage'), posts: [{ type: 'reset-stage' }], rid: false, pendingSel: false,
  },
  {
    act: 'deliver-to-pr', state: shipMenuState, sel: act('deliver-to-pr'),
    posts: [{ type: 'deliver-to-pr' }], rid: false,
  },
  {
    act: 'inside-action', state: () => st('impl'), sel: act('inside-action', '[data-action-id="fixture:open-full-evidence:1"]'),
    posts: [{ type: 'inside-action', actionId: 'fixture:open-full-evidence:1' }], rid: true,
  },
  {
    act: 'console', state: () => st('uat'), sel: act('console', '[data-console="uat"]:not([data-console-proc])'),
    posts: [{ type: 'xterm-request' }, { type: 'stage-log-request', stage: 'uat' }], rid: false, pendingSel: false,
  },
  {
    act: 'select-gate-attempt', state: attemptsState, sel: act('select-gate-attempt', '[data-key="r1"]'),
    posts: [{ type: 'select-gate-attempt', stage: 'review', key: 'r1' }], rid: false, pendingSel: false,
  },
  {
    act: 'select-findings-repo', state: findingsFilterState, sel: act('select-findings-repo', '[data-repo="fixture:/repos/api"]'),
    posts: [{ type: 'select-findings-repo', stage: 'review', repo: 'fixture:/repos/api' }], rid: false, pendingSel: false,
  },
  {
    act: 'set-disabled-gates',
    state: () => st('uat'),
    prep: (h) => {
      if (!q(h, act('set-disabled-gates'))) {
        h.receive({ type: 'gate-options', options: { uat: [{ name: 'e2e', disabled: false }], review: [] } });
      }
      headerMenu(act('set-disabled-gates'))(h);
    },
    sel: act('set-disabled-gates', '[data-name="e2e"]'),
    posts: [{ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: true }], rid: true,
  },

  // --- blocked banner ------------------------------------------------------
  {
    act: 'stage-resume', state: () => blockedState('boot-failed', true), sel: act('stage-resume', '[data-stagekey="uat"]'),
    posts: [{ type: 'stage-resume', ticketId: 942017, stageKey: 'uat' }], rid: true,
  },
  ...(['pick', 'retry', 'dismiss'] as const).map((k): ParityCase => ({
    act: `usage-limit-${k}`, state: () => blockedState('usage-limit', false), sel: act(`usage-limit-${k}`, '[data-stagekey="uat"]'),
    posts: [{ type: `usage-limit-${k}`, ticketId: 942017, stageKey: 'uat' }], rid: true,
  })),
  {
    act: 'baseline-approve', variant: 'one row', state: baselineState, sel: act('baseline-approve', '[data-indices="1"]'),
    posts: [{ type: 'baseline-approve', blockId: 'baseline-review', indices: [1] }], rid: true,
  },
  {
    act: 'baseline-approve', variant: 'approve all', state: baselineState, sel: act('baseline-approve', '[data-indices="0,1"]'),
    posts: [{ type: 'baseline-approve', blockId: 'baseline-review', indices: [0, 1] }], rid: true,
  },
  { act: 'baseline-view', state: baselineState, sel: act('baseline-view', '[data-index="0"]'), posts: [], pendingSel: false },
  { act: 'baseline-reject-open', state: baselineState, sel: act('baseline-reject-open', '[data-index="0"]'), posts: [], pendingSel: false },
  {
    act: 'baseline-reject-cancel', state: baselineState, prep: ensureClick(act('baseline-reject-open', '[data-index="0"]'), act('baseline-reject-cancel')),
    sel: act('baseline-reject-cancel'), posts: [], pendingSel: false,
  },
  {
    act: 'baseline-reject', variant: 'empty reason is refused locally', state: baselineState,
    prep: ensureClick(act('baseline-reject-open', '[data-index="0"]'), act('baseline-reject')),
    sel: act('baseline-reject', '[data-index="0"]'), posts: [], pendingSel: false,
  },
  {
    act: 'baseline-reject', variant: 'with a reason', state: baselineState,
    prep: (h) => {
      ensureClick(act('baseline-reject-open', '[data-index="0"]'), act('baseline-reject'))(h);
      const ta = h.query<HTMLTextAreaElement>('[data-bl-reason="0"]')!;
      ta.value = '  button is clipped  ';
      ta.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    },
    sel: act('baseline-reject', '[data-index="0"]'),
    posts: [{ type: 'baseline-reject', blockId: 'baseline-review', index: 0, reason: 'button is clipped' }], rid: true,
  },

  {
    act: 'toggle-graph-view', state: graphState, sel: act('toggle-graph-view'), posts: [], pendingSel: false,
    after: (h) => expect(q(h, act('toggle-graph-view'))!.getAttribute('aria-pressed')).toBe('true'),
  },
  {
    act: 'artifact-findings-repo', state: artifactFindingsState,
    prep: ensureClick('[data-art-open="uat-report"]', act('artifact-findings-repo', '[data-repo="/wt/api"]')),
    sel: act('artifact-findings-repo', '[data-repo="/wt/api"]'), posts: [], pendingSel: false,
    after: (h) => expect(q(h, act('artifact-findings-repo', '[data-repo="/wt/api"]'))!.getAttribute('aria-pressed')).toBe('true'),
  },

  // --- artifacts -----------------------------------------------------------
  {
    act: 'artifact-open-resource', state: artifactState, prep: ensureClick('[data-art-open="uat-report"]', act('artifact-open-resource')),
    sel: act('artifact-open-resource', '[data-index="1"]'), posts: [{ type: 'artifact-open-resource', artifactId: 'uat-report', index: 1 }], rid: true,
  },
  ...(
    [
      ['stored-artifact-open', 'latest', '.sa-main ', { type: 'stored-artifact-open', path: 'web/docs/a.md', sha: 'sha-new' }, '[data-sha="sha-new"]'],
      ['stored-artifact-live', '', '', { type: 'stored-artifact-live', path: 'web/docs/a.md' }, ''],
      ['stored-artifact-diff', '', '', { type: 'stored-artifact-diff', path: 'web/docs/a.md', from: 'sha-old', to: 'sha-new' }, ''],
      ['stored-artifact-reveal', '', '', { type: 'stored-artifact-reveal' }, ''],
      ['stored-artifact-purge', '', '', { type: 'stored-artifact-purge' }, ''],
    ] as const
  ).map(([a, , scope, msg, extra]): ParityCase => ({
    act: a,
    variant: scope ? 'latest revision' : undefined,
    state: storedState,
    prep: ensureClick('[data-art="stored"]', act(a)),
    sel: scope + act(a, extra),
    posts: [msg],
    rid: true,
  })),
];

/** Acts the guard accepts without a case — each with the reason it cannot be driven through the DOM. */
export const NOT_COVERED: Readonly<Record<string, string>> = {
};

// ---- the coverage guard ---------------------------------------------------

const html = readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'dashboard', 'webview.html'), 'utf8');

/** Every `data-act="…"` literal in the React app's components: a migrated panel's acts leave webview.html. */
function actsInReactApp(dir = join(RUNTIME_ASSETS_ROOT, 'ui', 'dashboard', 'app')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return actsInReactApp(path);
    if (!/\.tsx$/.test(entry.name) || /\.test\.tsx$/.test(entry.name)) return [];
    return [...readFileSync(path, 'utf8').matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]!);
  });
}

/** SEND_BY_ACT's keys plus every `act === '…'` branch and the CONSOLE_ACT constant, read from the source, plus the React app's acts. */
function actsInSource(): string[] {
  const map = /const SEND_BY_ACT = \{([\s\S]*?)\n {2}\};/.exec(html)?.[1] ?? '';
  const keys = [...map.matchAll(/^ {4}'([a-z-]+)':/gm)].map((m) => m[1]!);
  const branches = [...html.matchAll(/\bact === '([a-z-]+)'/g)].map((m) => m[1]!);
  const consoleAct = /const CONSOLE_ACT = '([a-z-]+)'/.exec(html)?.[1];
  return [...new Set([...keys, ...branches, ...(consoleAct ? [consoleAct] : []), ...actsInReactApp()])].sort();
}

describe('dashboard parity — coverage guard', () => {
  const sourceActs = actsInSource();
  const covered = new Set(COVERED.map((c) => c.act));

  it('reads a plausible act list from the source', () => {
    expect(sourceActs.length).toBeGreaterThan(55);
    expect(sourceActs).toContain('merge-pr');
    expect(sourceActs).toContain('stop-server');
  });

  it.each(sourceActs)('act %s has a parity case or an explicit NOT_COVERED reason', (a) => {
    expect(covered.has(a) || a in NOT_COVERED, `no parity case for data-act="${a}"`).toBe(true);
  });

  it('NOT_COVERED holds only real acts, each with a reason, never also covered', () => {
    for (const [a, why] of Object.entries(NOT_COVERED)) {
      expect(sourceActs, `stale NOT_COVERED entry ${a}`).toContain(a);
      expect(why.length).toBeGreaterThan(10);
      expect(covered.has(a), `${a} is both covered and NOT_COVERED`).toBe(false);
    }
  });

  it('every case names an act the source still has', () => {
    for (const c of COVERED) expect(sourceActs, `case for unknown act ${c.act}`).toContain(c.act);
  });
});

// ---- the oracle -----------------------------------------------------------

describe('dashboard parity — click → posted message', () => {
  it.each(COVERED.map((c) => ({ ...c, id: c.variant ? `${c.act} (${c.variant})` : c.act })))('$id', async (c) => {
    const h = await renderWebviewReady('dashboard');
    try {
      polyfillCss(h);
      h.receive({ type: 'state', state: c.state() });
      await c.prep?.(h);
      const el = q(h, c.sel);
      expect(el, `control ${c.sel} did not render`).not.toBeNull();
      expect(isShown(el!), `control ${c.sel} is hidden`).toBe(true);

      const before = h.posted.length;
      clickEl(el!);
      const sent = h.posted.slice(before) as Array<Record<string, unknown>>;

      expect(sent.map(({ requestId: _r, ...rest }) => rest)).toEqual(c.posts);
      sent.forEach((m, i) => {
        // The first message of a requestId control carries the correlation id.
        const wantsId = c.rid === true && i === sent.length - 1;
        if (wantsId) expect(typeof m.requestId, `${String(m.type)} lacks requestId`).toBe('string');
        else expect('requestId' in m, `${String(m.type)} must not carry a requestId`).toBe(false);
      });
      expect(h.errors).toEqual([]);

      c.after?.(h);
      if (c.repeat) {
        // The control re-renders (a menu item): re-find it; a repeat is dropped.
        await c.prep?.(h);
        const n = h.posted.length;
        clickEl(q(h, c.sel)!);
        expect(h.posted.length, 'repeat click posted again').toBe(n);
      }
      if (c.posts.length === 0 || c.pendingSel === false) return;

      const pending = q(h, c.pendingSel ?? c.sel);
      expect(pending, `no pending marker at ${c.pendingSel ?? c.sel}`).not.toBeNull();
      expect(pending!.getAttribute('aria-busy')).toBe('true');
      const n = h.posted.length;
      clickEl(pending!);
      expect(h.posted.length, 'repeat click while pending posted again').toBe(n);
    } finally {
      h.close();
    }
  });
});
