// @vitest-environment jsdom
/**
 * Dashboard region parity oracle (migration plan §3 A2, §5 Phase 1).
 *
 * One DOM-contract snapshot per region x host state, taken through the real
 * jsdom harness. It passes on the vanilla `webview.html` today and must pass
 * UNCHANGED once a region is re-implemented in React: same ids, classes,
 * data-* hooks, ARIA and text (the sidebar precedent, `ui:REACT-VIEWS`).
 * Never re-record a snapshot to make a slice pass; a diff is a parity break.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import {
  implementationPrototypeFixture,
  populatedStateFor,
  renderStateFor,
  sharedServerFixtures,
  shipPreviewStateFor,
} from '../renderFixtures.js';
import type { DashboardState } from '../state.js';

// ---------------------------------------------------------------------------
// domSignature: a stable, readable serialisation of a subtree.
// ---------------------------------------------------------------------------

/** Volatile text (ids, clocks, stamps) replaced by placeholders, in order. */
const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'],
  [/\brq-[\w-]+\b/g, '<request-id>'],
  [/\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b/g, '<iso>'],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}:\d\d(?::\d\d)?(?: ?[AP]M)?/gi, '<stamp>'],
  [/\b\d{1,2}:\d\d:\d\d\b/g, '<clock>'],
  [/\b\d+(?:\.\d+)?(?:ms|s|m|h|d)\b(?: ago)?/g, '<dur>'],
];
const norm = (s: string): string => VOLATILE.reduce((acc, [re, to]) => acc.replace(re, to), s).replace(/\s+/g, ' ').trim();

const KEPT_ATTRS = /^(data-|aria-)|^(role|hidden|disabled|title|type|href|placeholder|for|tabindex)$/;

function describeElement(el: Element): string {
  const cls = [...el.classList].sort().map((c) => `.${c}`).join('');
  const attrs = [...el.attributes]
    .filter((a) => KEPT_ATTRS.test(a.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => (a.value === '' ? a.name : `${a.name}="${norm(a.value)}"`));
  const id = el.id ? `#${norm(el.id)}` : '';
  return `<${el.tagName.toLowerCase()}${id}${cls}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
}

// Tag, id, sorted classes, data-*, role, aria-*, hidden, disabled, title and direct text: one line per element.
export function domSignature(el: Element, depth = 0): string {
  const pad = '  '.repeat(depth);
  const text = [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => norm(n.textContent ?? ''))
    .filter(Boolean)
    .join(' ');
  const head = `${pad}${describeElement(el)}${text ? ` "${text}"` : ''}`;
  // SVG internals (paths, circles) are decoration; keep the <svg> shell only.
  if (el.tagName.toLowerCase() === 'svg') return head;
  const kids = [...el.children].map((c) => domSignature(c, depth + 1));
  return [head, ...kids].join('\n');
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const AT = '2026-08-11T14:00:00.000Z';
type Build = () => DashboardState;
const populated = (stage: Parameters<typeof populatedStateFor>[0] = 'impl'): DashboardState => populatedStateFor(stage);
const withStage = (stage: 'uat' | 'ship', blocked: NonNullable<DashboardState['currentStage']>['blocked']): DashboardState => {
  const s = populated(stage);
  const cell = { stageKey: stage, status: 'running' as const, blocked };
  return { ...s, currentStage: cell, stepper: s.stepper.map((c) => (c.stageKey === stage ? cell : c)) };
};
const protoEnvelope = (): DashboardState => {
  const f = implementationPrototypeFixture();
  const base = populated(f.stage);
  return { ...base, insideViews: { ...base.insideViews, [f.stage]: f.view } };
};

const OPUS = { provider: 'claude', model: 'claude-opus-5-5' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5' };
const caps = (review: typeof OPUS): DashboardState['capabilityIdentity'] =>
  ({ ...renderStateFor('impl').capabilityIdentity, implementation: OPUS, uatTester: OPUS, review }) as DashboardState['capabilityIdentity'];
const catalog = { claude: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }], codex: [], opencode: [], antigravity: [] };

const row = (over: Record<string, unknown>) => ({ ...populated().prs[0]!, ...over });
const multiRepoPrs = (): DashboardState['prs'] => [
  row({ canMerge: true, mergeBlockedReason: '', canDismiss: true, checks: { state: 'passing', label: '3 passed', title: '3 checks passed', detailsLabel: '', failing: [] } }),
  row({
    repo: 'fixture:/repos/api', repoDisplay: 'api', number: 88, url: 'fixture:https://github.com/fixture-org/api/pull/88',
    canMerge: false, mergeBlockedReason: 'merge conflicts', mergeBlockLabel: 'conflicts', canDismiss: true, comments: [], commentsLabel: '',
    checks: { state: 'failing', label: '1 failing', title: '1 failing', detailsLabel: '1 failing check', failing: [{ name: 'unit', url: null, conclusion: 'failure' }] },
  }),
  row({
    repo: 'fixture:/repos/docs', repoDisplay: 'docs', number: 7, url: 'fixture:https://github.com/fixture-org/docs/pull/7',
    status: 'closed', dismissed: true, dismissedLabel: 'dismissed Aug 11, 2026, 2:10 PM', canMerge: false, canDismiss: false, comments: [], commentsLabel: '',
  }),
] as DashboardState['prs'];
const conflictCheck = (): DashboardState['mergeChecks'] => [
  { repo: 'fixture:/repos/api', state: 'conflicted', headline: 'conflicted · 2 files · vs main', detailsLabel: '2 conflicting files', files: ['src/a.ts', 'src/b.ts'], reason: '', checkedTitle: 'checked Aug 11, 2026, 2:05 PM' },
] as DashboardState['mergeChecks'];

const artifact = (over: Record<string, unknown>) => ({
  id: 'plan', stage: 'impl', kind: 'plan', title: 'Plan', scope: null, summary: '3 tasks · 2 done', status: 'info', freshness: 'current',
  origin: { kind: 'karst', core: 'codex' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: AT, metrics: [{ label: 'done', value: '2' }],
  gates: [], findings: [], prs: [], commits: [], tasks: [{ id: 'impl', label: 'Implement the feature', kind: 'agent', status: 'done', visits: 'visit 1' }],
  resources: [], detail: null, agentConsole: null, ...over,
});
const artifacts = (): DashboardState['artifacts'] => [
  artifact({}),
  artifact({
    id: 'uat-report', stage: 'uat', kind: 'uat-report', title: 'UAT report', summary: '2 passed · 1 failed', status: 'passed', tasks: [],
    gates: [{ name: 'lint', exitCode: 0 }, { name: 'e2e', exitCode: 2 }], agentConsole: 'tester',
    resources: [{ name: 'uat.log', path: '/data/uat.log', label: 'UAT log', taskId: null }],
  }),
  artifact({ id: 'review', stage: 'review', kind: 'review', title: 'Review', summary: '1 finding', status: 'attention', freshness: 'stale', tasks: [], createdAt: null }),
] as DashboardState['artifacts'];
const stored = (): NonNullable<DashboardState['storedArtifacts']> => ({
  total: 2, skips: [{ path: 'web/big.bin', reason: 'too large' }], globs: ['**/uat/**'],
  groups: [{ kind: 'screenshot', approaches: [{ approach: 'default', rows: [
    { path: 'web/a.png', repo: 'web', relPath: 'a.png', kind: 'screenshot', approach: 'default', source: 'uat', revisions: 2, lastAt: AT, latestSha: 'abcdef1234', history: [{ sha: 'abcdef1234', at: AT, source: 'uat' }, { sha: '1234abcdef', at: AT, source: 'uat' }] },
    { path: 'api/b.png', repo: 'api', relPath: 'b.png', kind: 'screenshot', approach: 'default', source: 'uat', revisions: 1, lastAt: AT, latestSha: 'fedcba9876', history: [{ sha: 'fedcba9876', at: AT, source: 'uat' }] },
  ] }] }],
}) as NonNullable<DashboardState['storedArtifacts']>;

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

type Drive = (h: RenderHandle) => Promise<void>;
async function mount(state: DashboardState, drive?: Drive): Promise<RenderHandle> {
  h = await renderWebviewReady('dashboard', { nonce: 'parity-nonce' });
  await h.receive({ type: 'state', state });
  await drainReactWork(h);
  if (drive) { await drive(h); await drainReactWork(h); }
  expect(h.errors).toEqual([]);
  return h;
}
const sign = (v: RenderHandle, selector: string): string => domSignature(v.query(selector) ?? (() => { throw new Error(`no ${selector}`); })());

type Case = readonly [region: string, selector: string, name: string, build: Build, drive?: Drive];

const openArt = (target: string): Drive => async (v) => { v.click(`[data-art="${target}"]`); };
const openArtDetail: Drive = async (v) => { v.click('#artPanel [data-art="index"]'); v.click('#artView [data-art-open="uat-report"]'); };
const click = (sel: string): Drive => async (v) => { v.click(sel); };

const HEADER: Case[] = [
  ['header', '.dhead', 'empty ticket', () => renderStateFor('impl')],
  ['header', '.dhead', 'populated impl with board link and priority', () => ({ ...populated(), provider: 'clickup', ticketUrl: 'fixture:https://app.clickup.com/t/abc', sourceRef: 'CU-abc', priority: 'urgent' })],
  ['header', '.dhead', 'sub-task that can detach', () => ({ ...populated(), canDetachSubtask: true })],
  ['header', '.dhead', 'closed ticket that can reopen', () => ({ ...populated('ship'), stageCurrent: 'closed', canClose: false, canReopen: true })],
  ['header', '.dhead', 'ship confirm', () => shipPreviewStateFor('ready')],
  ['header', '.dhead', 'ship waiting to merge', () => ({ ...populated('ship'), ship: { kind: 'waiting-merge', repos: 2 } })],
  ['header', '.dhead', 'ship retry after failure', () => ({ ...populated('ship'), ship: { kind: 'retry', reason: 'gh pr create failed' } })],
  ['header', '.dhead', 'paused execution', () => ({ ...populated(), paused: true, pausedAt: AT })],
  ['header', '.dhead', 'running agent with switch catalog', () => {
    const s = populated();
    return { ...s, agentState: 'running', agentSwitch: { ...s.agentSwitch, cores: [{ id: 'claude', label: 'Claude Code' }], modelsByCore: catalog as never } };
  }],
  ['headerMeta', '#headerMeta', 'all roles match implementation (hidden)', () => ({ ...populated(), capabilityIdentity: caps(OPUS) })],
  ['headerMeta', '#headerMeta', 'review differs (chip)', () => ({ ...populated(), agentSwitch: { ...populated().agentSwitch, modelsByCore: catalog as never }, capabilityIdentity: caps(SONNET) })],
  ['headerMeta', '#headerMeta', 'follow-up, blocked-by and sub-task relations', () => ({
    ...populated(), capabilityIdentity: caps(OPUS), parent: { key: 'FEAT-99', ref: 'T9 · FEAT-99', title: 'Earlier' },
    blockers: [{ ticketId: 42, idLabel: 'T42', label: 'CU-123' }, { ticketId: null, idLabel: null, label: 'external', done: true }],
  })],
];

const RAIL: Case[] = [
  ['rail', '#rail', 'empty ticket', () => renderStateFor('impl')],
  ['rail', '#rail', 'populated impl', () => populated('impl')],
  ['rail', '#rail', 'populated ship', () => populated('ship')],
  ['rail', '#rail', 'uat parked on a boot failure', () => withStage('uat', { kind: 'boot-failed', reason: 'api never became healthy', at: AT, resumable: true })],
];

const INSIDE: Case[] = [
  ['inside', '#inside', 'empty ticket', () => renderStateFor('impl')],
  ['inside', '#inside', 'implementation prototype', protoEnvelope],
  ['inside', '#inside', 'ship preview ready', () => shipPreviewStateFor('ready')],
  ['inside', '#inside', 'ship preview blocked', () => shipPreviewStateFor('blocked')],
  ['inside', '#inside', 'ship preview loading', () => shipPreviewStateFor('loading')],
];

const BLOCKED: Case[] = [
  ['blocked', '#blocked', 'no block (hidden)', () => populated('uat')],
  ['blocked', '#blocked', 'resumable boot failure', () => withStage('uat', { kind: 'boot-failed', reason: 'api never became healthy', at: AT, resumable: true })],
  ['blocked', '#blocked', 'usage-limit park actions', () => withStage('uat', { kind: 'usage-limit', reason: 'Claude quota exhausted until 5pm', at: AT, resumable: false })],
  ['blocked', '#blocked', 'awaiting-merge renders no banner', () => withStage('ship', { kind: 'awaiting-merge', reason: 'PRs open', at: AT, resumable: false })],
  ['blocked', '#blocked', 'baseline review with one pending row', () => ({
    ...withStage('uat', { kind: 'baseline-review', reason: '1 baseline changed', at: AT, resumable: false }),
    baselineReview: [{ index: 0, path: 'e2e/snap/home.png', label: 'home.png', status: 'modified', oldSrc: null, newSrc: null, decision: 'pending', reason: null }],
  })],
];

const ROOT: Case[] = [
  ['root', '#root', 'host project, no sandbox strip', () => populated()],
  ['root', '#root', 'sbx sandbox strip', () => ({ ...populated(), sandbox: { backend: 'sbx', core: 'claude', workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: false } })],
  ['root', '#root', 'sandbox strip with carry', () => ({ ...populated(), sandbox: { backend: 'sbx', core: 'claude', workspace: 'clone', network: 'sbx network policy (allowlist)', actions: true, carry: true } })],
];

const GRID: Case[] = [
  ['subtasks', '#subtaskPanel', 'none and cannot add (hidden)', () => renderStateFor('impl')],
  ['subtasks', '#subtaskPanel', 'none but can add', () => ({ ...renderStateFor('impl'), canAddSubtask: true })],
  ['subtasks', '#subtaskPanel', 'populated with progress', () => populated()],
  ['servers', '.svpanel', 'none, nothing runnable', () => renderStateFor('impl')],
  ['servers', '.svpanel', 'runnable but stopped (no rows)', () => ({ ...renderStateFor('impl'), hasRunnableRepos: true })],
  ['servers', '.svpanel', 'two running services', () => populated()],
  ['servers', '.svpanel', 'own and shared services', () => ({ ...populated(), sharedServers: sharedServerFixtures() })],
  ['worktrees', '#worktrees', 'none', () => renderStateFor('impl')],
  ['worktrees', '#worktrees', 'two repos', () => populated()],
  ['prs', '#prs', 'none', () => renderStateFor('impl')],
  ['prs', '#prs', 'one open PR awaiting review', () => populated()],
  ['prs', '#prs', 'multi-repo: merge, conflict, dismissed', () => ({ ...populated('ship'), prs: multiRepoPrs(), mergeChecks: conflictCheck() })],
  ['artifacts', '#artPanel', 'zero artifacts (hidden)', () => populated()],
  ['artifacts', '#artPanel', 'three artifacts', () => ({ ...populated(), artifacts: artifacts() })],
];

const withArt = (): DashboardState => ({ ...populated(), artifacts: artifacts(), storedArtifacts: stored() });
const OVERLAY: Case[] = [
  ['ticketData', '#ticketDataDrawer', 'closed', () => populated()],
  ['ticketData', '#ticketDataDrawer', 'open with brief', () => ({ ...populated(), brief: '# FEAT-142\n\nA brief.' }), click('#ticketDataBtn')],
  ['ticketData', '#ticketDataDrawer', 'open falling back to description', () => ({ ...populated(), description: 'Do the thing.' }), click('#ticketDataBtn')],
  ['artView', '#artView', 'closed', withArt],
  ['artView', '#artView', 'index', withArt, openArt('index')],
  ['artView', '#artView', 'detail', withArt, openArtDetail],
  ['termView', '#termView', 'closed', () => populated()],
  ['termView', '#termView', 'uat stage console while loading', () => populated('uat'), click('[data-act="console"][data-console="uat"]:not([data-console-proc])')],
  ['termView', '#termView', 'tester process console while loading', () => populated('uat'), click('[data-act="console"][data-console-proc="tester"]')],
  ['logsView', '#logsView', 'closed', () => populated()],
  ['logsView', '#logsView', 'open', () => populated(), click('[data-act="server-logs-request"]')],
  ['envView', '#envView', 'closed', () => populated()],
  ['envView', '#envView', 'editor open', () => ({ ...populated(), envOverrides: { services: ['web', 'api'], values: { '*': { A: '1' }, web: { PORT: '5173' } } } }), click('[data-act="env-overrides-open"]')],
];

describe('dashboard region parity (DOM contract)', () => {
  for (const [region, selector, name, build, drive] of [...HEADER, ...RAIL, ...INSIDE, ...BLOCKED, ...ROOT, ...GRID, ...OVERLAY]) {
    it(`${region} ${selector} · ${name}`, async () => {
      const v = await mount(build(), drive);
      expect(sign(v, selector)).toMatchSnapshot(`${region} · ${name}`);
    });
  }

  describe('visibility semantics', () => {
    const hidden = async (state: DashboardState, sel: string): Promise<boolean> => (await mount(state)).query(sel)!.classList.contains('hidden');

    it('sub-task panel is absent without sub-tasks unless one can be added', async () => {
      expect(await hidden(renderStateFor('impl'), '#subtaskPanel')).toBe(true);
      h?.close();
      expect(await hidden({ ...renderStateFor('impl'), canAddSubtask: true }, '#subtaskPanel')).toBe(false);
      h?.close();
      expect(await hidden(populated(), '#subtaskPanel')).toBe(false);
    });

    it('artifacts shelf is hidden with zero artifacts and shown otherwise', async () => {
      expect(await hidden(populated(), '#artPanel')).toBe(true);
      h?.close();
      expect(await hidden({ ...populated(), artifacts: artifacts() }, '#artPanel')).toBe(false);
    });

    it('blocked banner shows for resumable and usage-limit blocks, never for awaiting-merge', async () => {
      expect(await hidden(withStage('uat', { kind: 'boot-failed', reason: 'x', at: AT, resumable: true }), '#blocked')).toBe(false);
      h?.close();
      expect(await hidden(withStage('uat', { kind: 'usage-limit', reason: 'x', at: AT, resumable: false }), '#blocked')).toBe(false);
      h?.close();
      expect(await hidden(withStage('ship', { kind: 'awaiting-merge', reason: 'x', at: AT, resumable: false }), '#blocked')).toBe(true);
    });

    it('overlay hosts start hidden', async () => {
      const v = await mount(populated());
      for (const id of ['artView', 'termView', 'logsView', 'envView']) expect(v.query(`#${id}`)!.classList.contains('hidden')).toBe(true);
      expect(v.query('#ticketDataDrawer')!.getAttribute('aria-hidden')).toBe('true');
    });

    it('header Close/Reopen follow the host flags', async () => {
      const v = await mount({ ...populated('ship'), canClose: false, canReopen: true });
      expect(v.query('#closeTicket')!.classList.contains('hidden')).toBe(true);
      expect(v.query('#reopenTicket')!.classList.contains('hidden')).toBe(false);
    });
  });
});
