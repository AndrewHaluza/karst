// @vitest-environment jsdom
/**
 * The React Inside block must cooperate with what is still vanilla: persistence of the selection, the console
 * overlay, the ticket-data drawer, the artifact view and the page's ordered Escape chain; and with the React panels
 * it shares operations with (the pull request panel's Send CI failure). Complements interopRail (selection from the
 * rail's side) and the earlier interop files, which pass unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const REPO = 'fixture:/repos/web';
const open = async (state: DashboardState = populatedStateFor('uat')): Promise<RenderHandle> => {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state });
  await drainReactWork(h);
  return h;
};
const push = async (v: RenderHandle, state: DashboardState, extra: Record<string, unknown> = {}): Promise<void> => {
  v.receive({ type: 'state', state, ...extra });
  await drainReactWork(v);
};
const click = async (v: RenderHandle, sel: string): Promise<void> => {
  v.click(sel);
  await drainReactWork(v);
};
const escape = async (v: RenderHandle): Promise<void> => {
  v.document.body.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await drainReactWork(v);
};
const types = (v: RenderHandle, from: number): string[] => (v.posted.slice(from) as Array<{ type: string }>).map((m) => m.type);
const title = (v: RenderHandle): string => v.query('#inside-title')?.textContent ?? '';
const persisted = (v: RenderHandle): { sel?: unknown; shipWait?: unknown } => (v.state ?? {}) as { sel?: unknown; shipWait?: unknown };
const termOpen = (v: RenderHandle): boolean => !v.query('#termView')!.classList.contains('hidden');
const menuOpen = (v: RenderHandle): boolean => v.query('#inside .stageMenu') !== null;

const withMenu = (state: DashboardState, stage: string): DashboardState =>
  ({ ...state, sendBack: { available: true, stage }, ciFailure: { available: true, repos: [REPO] } }) as DashboardState;
const failingCi = (): DashboardState => {
  const s = populatedStateFor('ship');
  return withMenu({ ...s, prs: [{ ...s.prs[0]!, checks: { state: 'failing', label: 'f', title: '', detailsLabel: '1', failing: [{ name: 'lint', url: '' }] } }] } as DashboardState, 'ship');
};

describe('React Inside / vanilla page — selection and persistence', () => {
  it('a rail pick renders that stage’s Inside and the page persists sel (one way: React announces, the page writes)', async () => {
    const v = await open(populatedStateFor('impl'));
    expect(title(v)).toBe('Inside impl');
    const before = v.posted.length;
    await click(v, '#rail .pick[data-stage="review"]');
    expect(title(v)).toBe('Inside review');
    expect(v.query('#inside .vbar')!.textContent).toMatch(/^Viewing Review — not the current stage\./);
    expect(persisted(v).sel).toBe('review');
    expect(v.posted.length).toBe(before);
    expect(v.errors).toEqual([]);
  });

  it('Back in the Inside returns both the strip and the rail to the current stage and persists the reset', async () => {
    const v = await open(populatedStateFor('impl'));
    await click(v, '#rail .pick[data-stage="uat"]');
    await click(v, '#inside [data-back]');
    expect(title(v)).toBe('Inside impl');
    expect(v.query('#inside .vbar')).toBeNull();
    expect(v.queryAll('#rail .pick').filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => (p as HTMLElement).dataset.stage)).toEqual(['impl']);
    expect(persisted(v).sel).toBeNull();
  });

  it('persists the auto-selected Ship wait with the selection, so a reload does not yank the user back', async () => {
    const v = await open(populatedStateFor('impl'));
    await push(v, { ...populatedStateFor('ship'), ship: { kind: 'confirm' } } as DashboardState);
    expect(title(v)).toBe('Inside ship');
    expect(persisted(v)).toMatchObject({ sel: 'ship', shipWait: expect.stringMatching(/:confirm$/) });
  });

  it('an attempt tab or a stage-menu item no longer pins the selection (the old delegator selected data-stage controls)', async () => {
    const v = await open(withMenu(populatedStateFor('uat'), 'uat'));
    expect(persisted(v).sel ?? null).toBeNull();
    await click(v, '[data-stage-menu="uat"]');
    await click(v, '.stageMenu [data-act="send-back-to-implement"]');
    expect(persisted(v).sel ?? null).toBeNull();
  });

  it('no longer crosses the old selection or Send-CI seams', async () => {
    const v = await open(failingCi());
    const heard: string[] = [];
    for (const name of ['karst:selectStage', 'karst:stageSelection', 'karst:prBegin', 'karst:prPending']) {
      v.window.addEventListener(name, () => heard.push(name));
    }
    await click(v, '#rail .pick[data-stage="uat"]');
    await click(v, '#inside [data-back]');
    await click(v, '#prs .mg-ci-failing .mgbtn');
    expect(heard).toEqual([]);
  });
});

describe('React Inside / vanilla overlays — each opens exactly once', () => {
  it('the stage console opens the vanilla terminal surface once and posts the log request once', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    expect(termOpen(v)).toBe(true);
    expect(types(v, before)).toEqual(['xterm-request', 'stage-log-request']);
    expect(v.posted.slice(before).at(-1)).toMatchObject({ type: 'stage-log-request', stage: 'uat' });
    expect(v.errors).toEqual([]);
  });

  it('a gate-lane process console asks for that process’s log', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#inside [data-act="console"][data-console-proc="tester"]');
    expect(termOpen(v)).toBe(true);
    expect(v.posted.slice(before).at(-1)).toMatchObject({ type: 'agent-log-request', processId: 'tester' });
    expect(types(v, before).filter((t) => t === 'agent-log-request')).toHaveLength(1);
    expect(v.query('#inside [data-proc-id="uat:tester"]')!.hasAttribute('open')).toBe(false);
  });

  it('the header ticket-data button, the artifact shelf and the Inside console each open their surface once, side by side', async () => {
    const v = await open({ ...populatedStateFor('uat'), artifacts: [{ id: 'uat-report', stage: 'uat', kind: 'uat-report', title: 'UAT report', scope: null, summary: 's', status: 'passed', freshness: 'current', origin: { kind: 'karst', core: 'codex' }, versionCount: 1, currentVersionLabel: 'v1', createdAt: '2026-08-01T10:00:00.000Z', metrics: [], gates: [], findings: [], prs: [], commits: [], tasks: [], resources: [], detail: null, agentConsole: null }] } as unknown as DashboardState);
    await click(v, '#ticketDataBtn');
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(true);
    await escape(v);
    await click(v, '#artPanel [data-art="index"]');
    expect(v.query('#artView')!.classList.contains('hidden')).toBe(false);
    await escape(v);
    expect(v.query('#artView')!.classList.contains('hidden')).toBe(true);
    const before = v.posted.length;
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    expect(termOpen(v)).toBe(true);
    expect(types(v, before).filter((t) => t === 'stage-log-request')).toHaveLength(1);
  });
});

describe('React Inside / page Escape chain — the order is unchanged', () => {
  it('drawer first, then the stage menu, then the console', async () => {
    const v = await open(withMenu(populatedStateFor('uat'), 'uat'));
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    expect(termOpen(v)).toBe(true);
    // The header's own button is a click outside the menu (it would close it), so the drawer is opened before the menu.
    await click(v, '#ticketDataBtn');
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(true);
    await click(v, '[data-stage-menu="uat"]');
    expect(menuOpen(v)).toBe(true);
    expect(v.query('#ticketDataDrawer')!.classList.contains('open')).toBe(true);

    await escape(v);
    expect([v.query('#ticketDataDrawer')!.classList.contains('open'), menuOpen(v), termOpen(v)]).toEqual([false, true, true]);
    await escape(v);
    expect([menuOpen(v), termOpen(v)]).toEqual([false, true]);
    await escape(v);
    expect(termOpen(v)).toBe(false);
  });

  it('Escape with nothing to close does nothing; a click anywhere else closes the menu, in the React panels too', async () => {
    const v = await open(withMenu(populatedStateFor('uat'), 'uat'));
    await escape(v);
    expect(v.errors).toEqual([]);
    await click(v, '[data-stage-menu="uat"]');
    await click(v, '#idBadge');
    expect(menuOpen(v)).toBe(false);
    await click(v, '[data-stage-menu="uat"]');
    await click(v, '#prs');
    expect(menuOpen(v)).toBe(false);
  });
});

describe('React Inside / React panels — shared operations, never two dialogs', () => {
  it('the stage menu’s Send CI failure and the PR panel’s are one operation, from either side', async () => {
    let v = await open(failingCi());
    let before = v.posted.length;
    await click(v, '[data-stage-menu="ship"]');
    await click(v, '.stageMenu [data-act="send-ci-failure"]');
    await click(v, '#prs .mg-ci-failing .mgbtn');
    expect(types(v, before)).toEqual(['send-ci-failure']);
    expect(v.query<HTMLButtonElement>('#prs .mg-ci-failing .mgbtn')!.disabled).toBe(true);
    await push(v, failingCi());
    expect(v.query<HTMLButtonElement>('#prs .mg-ci-failing .mgbtn')!.disabled).toBe(false);

    v.close();
    v = await open(failingCi());
    before = v.posted.length;
    await click(v, '#prs .mg-ci-failing .mgbtn');
    await click(v, '[data-stage-menu="ship"]');
    await click(v, '.stageMenu [data-act="send-ci-failure"]');
    expect(types(v, before)).toEqual(['send-ci-failure']);
  });

  it('keeps the request across a live push, and settles it on the next settling one', async () => {
    const v = await open(failingCi());
    await click(v, '#prs .mg-ci-failing .mgbtn');
    await push(v, failingCi(), { live: true, settlesActions: false });
    expect(v.query<HTMLButtonElement>('#prs .mg-ci-failing .mgbtn')!.disabled).toBe(true);
    await push(v, failingCi());
    expect(v.query<HTMLButtonElement>('#prs .mg-ci-failing .mgbtn')!.disabled).toBe(false);
  });
});

describe('React Inside — a live push keeps what the user is doing', () => {
  it('does not collapse an open disclosure, does not lose focus, and keeps a pending control pending', async () => {
    const v = await open(populatedStateFor('uat'));
    const row = v.query<HTMLDetailsElement>('#inside [data-proc-id="uat:gates"]')!;
    row.open = true;
    row.dispatchEvent(new v.window.Event('toggle'));
    const btn = v.query<HTMLButtonElement>('#inside [data-act="inside-action"]')!;
    btn.focus();
    const id = btn.dataset.actionId;
    const before = v.posted.length;
    v.click(`#inside [data-act="inside-action"][data-action-id="${id}"]`);
    await drainReactWork(v);
    expect(types(v, before)).toEqual(['inside-action']);
    for (let i = 0; i < 3; i += 1) await push(v, populatedStateFor('uat'), { live: true, settlesActions: false });
    await push(v, populatedStateFor('uat'));
    expect(v.query('#inside [data-proc-id="uat:gates"]')).toBe(row);
    expect(row.open).toBe(true);
    expect(v.document.activeElement).toBe(btn);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(v.errors).toEqual([]);
  });

  it('a clocks repaint advances the header clock in place, with no new snapshot', async () => {
    const v = await open(populatedStateFor('uat'));
    const meta = v.query('#inside .inside-meta')!;
    v.receive({ type: 'clocks', clocks: { uat: { clock: 'advanced uat clock', processes: {} } } });
    await drainReactWork(v);
    expect(v.query('#inside .inside-meta')).toBe(meta);
    expect(meta.textContent).toBe('advanced uat clock');
  });
});
