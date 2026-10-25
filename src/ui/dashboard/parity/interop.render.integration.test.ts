// @vitest-environment jsdom
/** Vanilla document delegators and the React Worktrees island must cooperate (outside-click, Escape priority, pending class). */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, pumpRenderRealm, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { buildStageRail } from '../../../model/stageRail.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const BRANCH = 'feat/FEAT-142-base-branch-override';
const FORM = '[data-wbase-popover]';

async function open(): Promise<RenderHandle> {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state: populatedStateFor('impl') });
  await drainReactWork(h);
  return h;
}

const click = async (v: RenderHandle, sel: string): Promise<void> => {
  v.click(sel);
  await drainReactWork(v);
};
const eightServers = (): DashboardState => {
  const base = populatedStateFor('impl');
  const servers = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, ticketId: base.ticketId, service: `svc-${i + 1}`, host: 'localhost', port: 3000 + i, status: 'running', logPath: null,
  }));
  return { ...base, servers } as DashboardState;
};
/** Type like a user: the native value setter plus a bubbling `input` event, which is what React listens to. */
const typeInto = async (v: RenderHandle, input: HTMLInputElement, value: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(v.window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new v.window.Event('input', { bubbles: true }));
  await drainReactWork(v);
};
const escape = async (v: RenderHandle): Promise<void> => {
  v.document.body.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await drainReactWork(v);
};

describe('React island / vanilla delegator interop', () => {
  it('a click inside the Worktrees island closes the header popovers', async () => {
    const v = await open();
    v.click('#agentButton');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(false);
    await click(v, '[data-act="show-changes"]');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(true);
    v.click('#moreBtn');
    expect(v.query('#menuPopover')!.classList.contains('hidden')).toBe(false);
    await click(v, '.wt .wrepo');
    expect(v.query('#menuPopover')!.classList.contains('hidden')).toBe(true);
  });

  it('Escape closes the ticket-data drawer first, then the open base form', async () => {
    const v = await open();
    v.click('#ticketDataBtn');
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(true);
    await click(v, '[data-act="toggle-base-form"]');
    expect(v.query(FORM)).not.toBeNull();
    await escape(v);
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(false);
    expect(v.query(FORM)).not.toBeNull();
    await escape(v);
    expect(v.query(FORM)).toBeNull();
  });

  it('typing in the Servers filter narrows the rows, keeps focus, and persists through vanilla', async () => {
    const v = await open();
    v.receive({ type: 'state', state: eightServers() });
    await drainReactWork(v);
    const input = v.query<HTMLInputElement>('#srvFilter')!;
    input.focus();
    await typeInto(v, input, 'svc-2');
    expect(v.query('#srvFilter')).toBe(input);
    expect(v.document.activeElement).toBe(input);
    expect(v.queryAll('#servers td.c-name')).toHaveLength(1);
    // React never writes vscode.setState: the vanilla seam listener persisted the filter.
    expect((v.state as { srvFilter?: string }).srvFilter).toBe('svc-2');
    await typeInto(v, input, 'svc-23');
    expect((v.state as { srvFilter?: string }).srvFilter).toBe('svc-23');
    expect(v.errors).toEqual([]);
  });

  it('a server action click inside the island posts exactly once (no vanilla double handling)', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '[data-act="stop-server"][data-id="1"]');
    const sent = v.posted.slice(before) as Array<{ type: string }>;
    expect(sent.map((m) => m.type)).toEqual(['stop-server']);
  });

  it('clicking Add sub-task posts exactly once (no vanilla double post) and holds the button pending', async () => {
    const v = await renderWebviewReady('dashboard');
    h = v;
    v.receive({ type: 'state', state: { ...populatedStateFor('impl'), canAddSubtask: true } });
    await drainReactWork(v);
    const before = v.posted.length;
    await click(v, '#addSubtask');
    const sent = v.posted.slice(before) as Array<{ type: string }>;
    expect(sent.map((m) => m.type)).toEqual(['create-subtask']);
    expect(v.query('#addSubtask')!.classList.contains('is-pending')).toBe(true);
  });

  it('the header Logs and Env buttons open their vanilla surfaces once', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#srvOps [data-act="env-overrides-open"]');
    expect(v.document.body.classList.contains('env-nav')).toBe(true);
    expect(v.posted.length).toBe(before);
    await escape(v);
    await click(v, '#srvOps [data-act="server-logs-request"]');
    const sent = v.posted.slice(before) as Array<{ type: string }>;
    expect(sent.map((m) => m.type)).toEqual(['server-logs-request']);
  });

  it('the copy flash keeps the runtime pending class, also across a re-render', async () => {
    const v = await open();
    const sel = `[data-act="copy-worktree-branch"][data-branch="${BRANCH}"]`;
    v.click(sel);
    // Pump only a few ticks: draining to quiescence would outlast the 1.2 s flash.
    for (let i = 0; i < 3; i++) await pumpRenderRealm(v);
    const btn = (): HTMLElement => v.query<HTMLElement>(sel)!;
    expect(btn().classList.contains('is-pending')).toBe(true);
    expect(btn().getAttribute('aria-label')).toBe('Copied');
    expect(btn().hasAttribute('data-copied')).toBe(true);
    v.receive({ type: 'state', state: populatedStateFor('impl') });
    for (let i = 0; i < 3; i++) await pumpRenderRealm(v);
    expect(btn().classList.contains('is-pending')).toBe(true);
    expect(btn().hasAttribute('data-copied')).toBe(true);
  });
});

// ---- Pull requests island -------------------------------------------------

const REPO = 'fixture:/repos/web';
const PR_URL = 'fixture:https://github.com/fixture-org/web/pull/421';
const shipWith = (prOver: Record<string, unknown>, over: Record<string, unknown> = {}): DashboardState => {
  const s = populatedStateFor('ship');
  return { ...s, prs: [{ ...s.prs[0]!, ...prOver }], ...over } as DashboardState;
};
const mergeable = (over: Record<string, unknown> = {}): DashboardState => shipWith({ canMerge: true, mergeBlockedReason: '' }, over);
const railMerge = (): DashboardState => {
  const s = mergeable();
  const rail = buildStageRail(s.stepper, s.stepper, {
    current: 'ship', needsUser: true, needs: { detail: 'needs you', action: 'Merge', cta: { kind: 'merge', repo: REPO } },
  } as unknown as Parameters<typeof buildStageRail>[2]);
  return { ...s, rail } as DashboardState;
};
const failingCi = (): DashboardState =>
  shipWith(
    { checks: { state: 'failing', label: 'failing', title: '', detailsLabel: '1 failing', failing: [{ name: 'lint', url: '' }] } },
    { ciFailure: { available: true, repos: [REPO] } },
  );
const push = async (v: RenderHandle, state: DashboardState, extra: Record<string, unknown> = {}): Promise<void> => {
  v.receive({ type: 'state', state, ...extra });
  await drainReactWork(v);
};
const openWith = async (state: DashboardState): Promise<RenderHandle> => {
  h = await renderWebviewReady('dashboard');
  await push(h, state);
  return h;
};
const sentTypes = (v: RenderHandle, from: number): string[] => (v.posted.slice(from) as Array<{ type: string }>).map((m) => m.type);
const MERGE = `.mgbtn[data-act="merge-pr"][data-repo="${REPO}"]`;

describe('React Pull requests island / vanilla page interop', () => {
  it('a click inside the PR island closes the header popovers', async () => {
    const v = await openWith(mergeable());
    v.click('#agentButton');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(false);
    await click(v, '#prs .pst');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(true);
  });

  it('a Merge click posts exactly {type, repo} once, and the rail button goes busy with it', async () => {
    const v = await openWith(railMerge());
    const before = v.posted.length;
    await click(v, `#prs ${MERGE}`);
    expect(v.posted.slice(before)).toEqual([{ type: 'merge-pr', repo: REPO }]);
    expect(v.query(`.go[data-repo="${REPO}"]`)!.getAttribute('aria-busy')).toBe('true');
    expect(v.query<HTMLButtonElement>('#prs .pacts .mgbtn:last-child')!.disabled).toBe(true);
  });

  it('a pending merge survives live and passive pushes, then a settling push clears panel and rail', async () => {
    const v = await openWith(railMerge());
    await click(v, `#prs ${MERGE}`);
    await push(v, railMerge(), { live: true, settlesActions: false });
    await push(v, railMerge(), { settlesActions: false });
    expect(v.query<HTMLButtonElement>('#prs .pacts .mgbtn:last-child')!.disabled).toBe(true);
    expect(v.query(`.go[data-repo="${REPO}"]`)!.getAttribute('aria-busy')).toBe('true');
    await push(v, railMerge());
    expect(v.query<HTMLButtonElement>('#prs .pacts .mgbtn:last-child')!.disabled).toBe(false);
    expect(v.query(`.go[data-repo="${REPO}"]`)!.hasAttribute('aria-busy')).toBe(false);
    expect(v.errors).toEqual([]);
  });

  it('a Merge started from the rail makes the panel Merge pending, and the panel posts nothing', async () => {
    const v = await openWith(railMerge());
    const before = v.posted.length;
    await click(v, `.go[data-act="merge-pr"]`);
    expect(sentTypes(v, before)).toEqual(['merge-pr']);
    expect(v.query<HTMLButtonElement>('#prs .pacts .mgbtn:last-child')!.disabled).toBe(true);
    await click(v, '#prs .pacts .mgbtn:last-child');
    expect(sentTypes(v, before)).toEqual(['merge-pr']);
  });

  it('Send CI failure is one operation across the panel and the stage menu', async () => {
    const v = await openWith(failingCi());
    const before = v.posted.length;
    await click(v, '#prs .mg-ci-failing .mgbtn');
    expect(sentTypes(v, before)).toEqual(['send-ci-failure']);
    expect(v.query<HTMLButtonElement>('#prs .mg-ci-failing .mgbtn')!.disabled).toBe(true);
    await push(v, failingCi());
    expect(v.query<HTMLButtonElement>('#prs .mg-ci-failing .mgbtn')!.disabled).toBe(false);
  });

  it('open-pr from the PR panel posts once; the artifact view (vanilla) still posts it too', async () => {
    const v = await openWith(mergeable());
    const before = v.posted.length;
    await click(v, `#prs [data-act="open-pr"][data-url="${PR_URL}"]`);
    expect(v.posted.slice(before)).toMatchObject([{ type: 'open-pr', url: PR_URL }]);

    const art = {
      id: 'ship-pr', stage: 'ship', kind: 'plan', title: 'Delivery', scope: null, summary: '', status: 'info', freshness: 'current',
      origin: { kind: 'karst', core: 'codex' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: null, metrics: [], gates: [], findings: [],
      prs: [{ repo: REPO, number: 421, url: PR_URL, status: 'open' }], commits: [], tasks: [], resources: [], detail: null, agentConsole: null,
    };
    await push(v, { ...mergeable(), artifacts: [art] } as unknown as DashboardState);
    (v.window as unknown as { CSS: { escape(s: string): string } }).CSS = { escape: (x: string) => x };
    await click(v, '#artPanel [data-art="index"]');
    await click(v, '#artView [data-art-open="ship-pr"]');
    const mark = v.posted.length;
    await click(v, `#artView [data-act="open-pr"][data-url="${PR_URL}"]`);
    expect(v.posted.slice(mark)).toMatchObject([{ type: 'open-pr', url: PR_URL }]);
  });

  it('a refresh stays pending across a passive push and ends on a settling one', async () => {
    const v = await openWith(mergeable());
    const before = v.posted.length;
    await click(v, '#prRefresh');
    expect(v.posted.slice(before)).toEqual([{ type: 'refresh-prs' }]);
    await push(v, mergeable(), { live: true, settlesActions: false });
    expect(v.query<HTMLButtonElement>('#prRefresh')!.disabled).toBe(true);
    await push(v, mergeable());
    expect(v.query<HTMLButtonElement>('#prRefresh')!.disabled).toBe(false);
  });
});

const shelfArt = (id: string, title: string, stage = 'impl') => ({
  id, stage, kind: id, title, scope: null, summary: `${title} summary`, status: 'info', freshness: 'current',
  origin: { kind: 'karst', core: 'codex' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: null, metrics: [], gates: [], findings: [],
  prs: [], commits: [], tasks: [], resources: [], detail: null, agentConsole: null,
});
const withShelf = (): DashboardState =>
  ({
    ...populatedStateFor('impl'),
    artifacts: [shelfArt('plan', 'Plan'), shelfArt('uat-report', 'UAT report', 'uat')],
    storedArtifacts: { total: 0, skips: [], globs: ['**/uat/**'], groups: [] },
  }) as unknown as DashboardState;
const artViewOpen = (v: RenderHandle): boolean => !v.query('#artView')!.classList.contains('hidden');
const persistedArtView = (v: RenderHandle): unknown => (v.state as { artView?: unknown } | undefined)?.artView;

describe('React Artifacts shelf and Captured artifacts islands / vanilla art view interop', () => {
  const openShelf = async (): Promise<RenderHandle> => {
    const v = await openWith(withShelf());
    (v.window as unknown as { CSS: { escape(s: string): string } }).CSS = { escape: (x: string) => x };
    return v;
  };

  it('a shelf card opens the vanilla detail view, shows the overlay and persists artView', async () => {
    const v = await openShelf();
    expect(artViewOpen(v)).toBe(false);
    await click(v, '#artifacts [data-art-open="uat-report"]');
    expect(artViewOpen(v)).toBe(true);
    expect(v.query('#artView')!.textContent).toContain('UAT report');
    expect(persistedArtView(v)).toEqual({ id: 'uat-report', from: 'ticket' });
  });

  it('View all opens the vanilla index once', async () => {
    const v = await openShelf();
    await click(v, '#artViewAll');
    expect(artViewOpen(v)).toBe(true);
    expect(v.queryAll('#artView .artrow')).toHaveLength(2);
    expect(persistedArtView(v)).toBe('index');
  });

  it('Open on the Captured artifacts panel opens the vanilla stored view', async () => {
    const v = await openShelf();
    await click(v, '#storedOpen');
    expect(artViewOpen(v)).toBe(true);
    expect(v.query('#artView')!.textContent).toContain('No artifacts captured yet.');
    expect(persistedArtView(v)).toBe('stored');
  });

  it('a click inside either panel closes the header popovers', async () => {
    const v = await openShelf();
    v.click('#agentButton');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(false);
    await click(v, '#storedOpen');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(true);
  });

  it('Escape closes the overlay a panel opened, and the shelf is still there', async () => {
    const v = await openShelf();
    await click(v, '#artViewAll');
    await escape(v);
    expect(artViewOpen(v)).toBe(false);
    expect(persistedArtView(v)).toBeNull();
    expect(v.queryAll('#artifacts .artcard')).toHaveLength(2);
  });
});

