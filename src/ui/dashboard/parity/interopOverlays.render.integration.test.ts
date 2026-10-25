// @vitest-environment jsdom
/**
 * The React overlay views (ticket-data drawer, artifact view, console, server logs, env editor) in the real page: each
 * opener opens its overlay exactly once, the ordered Escape chain is the one overlay stack's, Back and the scroll memory
 * survive a round trip and a reload, the page persists the view state React announces, and an unsaved env edit survives a
 * push. Complements the earlier interop files, which pass unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebview, renderWebviewReady, waitForSettingsReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { artifactFixtures, storedView } from '../app/fixtures/artifactFixtures.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const REAL_STATE = (): DashboardState => {
  const base = populatedStateFor('uat');
  const servers = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, ticketId: base.ticketId, service: `svc-${i + 1}`, host: 'localhost', port: 3000 + i, status: 'running', logPath: null }));
  return {
    ...base,
    servers,
    brief: '# FEAT-142\n\nA brief.',
    artifacts: artifactFixtures(),
    storedArtifacts: storedView,
    envOverrides: { services: ['web', 'api'], values: { '*': { SHARED: 'yes' }, web: { PORT: '5173' } } },
  } as unknown as DashboardState;
};

const open = async (state: DashboardState = REAL_STATE()): Promise<RenderHandle> => {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state });
  await drainReactWork(h);
  return h;
};
const click = async (v: RenderHandle, sel: string): Promise<void> => {
  v.click(sel);
  await drainReactWork(v);
};
const escape = async (v: RenderHandle): Promise<KeyboardEvent> => {
  const e = new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  v.document.body.dispatchEvent(e);
  await drainReactWork(v);
  return e;
};
const types = (v: RenderHandle, from: number): string[] => (v.posted.slice(from) as Array<{ type: string }>).map((m) => m.type);
const shown = (v: RenderHandle, sel: string): boolean => !v.query(sel)!.classList.contains('hidden');
const drawerOpen = (v: RenderHandle): boolean => v.query('#ticketDataDrawer')!.classList.contains('open');
const persisted = (v: RenderHandle): Record<string, unknown> => (v.state ?? {}) as Record<string, unknown>;
const scrollTo = (v: RenderHandle, top: number): void => { v.document.documentElement.scrollTop = top; };
const scrollTop = (v: RenderHandle): number => v.document.documentElement.scrollTop;
const surfaces = (v: RenderHandle): string[] =>
  [drawerOpen(v) && 'drawer', shown(v, '#termView') && 'console', shown(v, '#logsView') && 'logs', shown(v, '#envView') && 'env', shown(v, '#artView') && 'art'].filter(Boolean) as string[];

/** The seams this phase collapsed: nothing may cross them any more. */
const COLLAPSED = ['karst:openTicketData', 'karst:openArt', 'karst:openTerminal', 'karst:openServerLogs', 'karst:openEnvOverrides', 'karst:stageMenuOpen', 'karst:closePopovers'];

describe('overlay openers — each opens its overlay exactly once', () => {
  it('the header ticket-data button opens the drawer, posts nothing and crosses no seam', async () => {
    const v = await open();
    const heard: string[] = [];
    for (const name of COLLAPSED) v.window.addEventListener(name, () => heard.push(name));
    const before = v.posted.length;
    await click(v, '#ticketDataBtn');
    expect(surfaces(v)).toEqual(['drawer']);
    expect(v.query('#ticketDataBody')!.textContent).toBe('# FEAT-142\n\nA brief.');
    expect(v.posted.length).toBe(before);
    expect(v.queryAll('#ticketDataDrawer')).toHaveLength(1);
    expect(heard).toEqual([]);
  });

  it('the shelf card, View all and the stored Open each open the artifact view once and persist it once', async () => {
    const v = await open();
    await click(v, '#artifacts [data-art-open="uat-report"]');
    expect(surfaces(v)).toEqual(['art']);
    expect(v.query('#artView .art-title')!.textContent).toBe('UAT report');
    expect(persisted(v).artView).toEqual({ id: 'uat-report', from: 'ticket' });
    await escape(v);
    await click(v, '#artViewAll');
    expect(v.queryAll('#artView .artrow')).toHaveLength(4);
    expect(persisted(v).artView).toBe('index');
    await escape(v);
    await click(v, '#storedOpen');
    expect(v.query('#artView')!.textContent).toContain('app / plans/a.md');
    expect(persisted(v).artView).toBe('stored');
    expect(v.errors).toEqual([]);
  });

  it('the Inside console opens the console once and asks the host once, for the xterm bundle and for the log', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    expect(surfaces(v)).toEqual(['console']);
    expect(v.document.body.classList.contains('term-nav')).toBe(true);
    expect(types(v, before)).toEqual(['xterm-request', 'stage-log-request']);
  });

  it('a console button on an artifact detail opens the same console, without leaving the detail', async () => {
    const v = await open();
    await click(v, '#artifacts [data-art-open="uat-report"]');
    const before = v.posted.length;
    await click(v, '#artView [data-act="console"][data-console-proc="tester"]');
    expect(surfaces(v)).toEqual(['console', 'art']);
    expect(v.posted.slice(before).at(-1)).toMatchObject({ type: 'agent-log-request', processId: 'tester' });
    await escape(v);
    expect(surfaces(v)).toEqual(['art']);
    expect(v.query('#artView .art-title')!.textContent).toBe('UAT report');
  });

  it('the Servers header Logs button opens the shared logs surface once; its own Close tells the host once', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#srvOps [data-act="server-logs-request"]');
    expect(surfaces(v)).toEqual(['logs']);
    expect(v.document.body.classList.contains('log-nav')).toBe(true);
    expect(types(v, before)).toEqual(['server-logs-request']);
    expect(v.queryAll('#logsView .thead')).toHaveLength(1);
    v.receive({ type: 'server-logs', servers: [{ service: 'web', content: 'hello\n', truncated: false }] });
    await drainReactWork(v);
    expect(v.query('#logsHost')!.textContent).toContain('hello');
    await click(v, '#logsView [data-log-close]');
    expect(surfaces(v)).toEqual([]);
    expect(types(v, before)).toEqual(['server-logs-request', 'server-logs-close']);
    // A second open reuses the surface and asks again.
    await click(v, '#srvOps [data-act="server-logs-request"]');
    expect(surfaces(v)).toEqual(['logs']);
    expect(types(v, before)).toEqual(['server-logs-request', 'server-logs-close', 'server-logs-request']);
    expect(v.errors).toEqual([]);
  });

  it('the Servers header Env button opens the editor once and posts nothing', async () => {
    const v = await open();
    const before = v.posted.length;
    await click(v, '#srvOps [data-act="env-overrides-open"]');
    expect(surfaces(v)).toEqual(['env']);
    expect(v.document.body.classList.contains('env-nav')).toBe(true);
    expect(v.queryAll('#envView .envscope')).toHaveLength(3);
    expect(v.posted.length).toBe(before);
  });
});

describe('overlay stack — the ordered Escape chain', () => {
  it('closes the drawer, console, logs, env editor and artifact view in that order, one press each', async () => {
    const v = await open();
    await click(v, '#artViewAll');
    await click(v, '#srvOps [data-act="env-overrides-open"]');
    await click(v, '#srvOps [data-act="server-logs-request"]');
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    await click(v, '#ticketDataBtn');
    expect(surfaces(v)).toEqual(['drawer', 'console', 'logs', 'env', 'art']);
    const trail: string[][] = [];
    for (let i = 0; i < 5; i += 1) {
      expect((await escape(v)).defaultPrevented).toBe(true);
      trail.push(surfaces(v));
    }
    expect(trail).toEqual([['console', 'logs', 'env', 'art'], ['logs', 'env', 'art'], ['env', 'art'], ['art'], []]);
    expect((await escape(v)).defaultPrevented).toBe(false);
    expect(v.document.body.className.trim()).toBe('');
    expect(v.errors).toEqual([]);
  });

  it('returns focus to the control that opened the drawer', async () => {
    const v = await open();
    const trigger = v.query<HTMLButtonElement>('#ticketDataBtn')!;
    trigger.focus();
    await click(v, '#ticketDataBtn');
    expect(v.document.activeElement).toBe(v.query('#ticketDataClose'));
    await escape(v);
    expect(v.document.activeElement).toBe(trigger);
  });

  it('a press that starts inside a React region belongs to that region', async () => {
    const v = await open();
    await click(v, '#ticketDataBtn');
    const input = v.query<HTMLElement>('#rail')!;
    const e = new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    await drainReactWork(v);
    expect(e.defaultPrevented).toBe(false);
    expect(drawerOpen(v)).toBe(true);
  });
});

describe('artifact view — Back, scroll memory and persistence', () => {
  it('Back from a detail returns to the index or the ticket and puts each surface back where it was', async () => {
    const v = await open();
    scrollTo(v, 500);
    await click(v, '#artViewAll');
    expect(scrollTop(v)).toBe(0);
    scrollTo(v, 80);
    await click(v, '#artView [data-art-open="review"]');
    expect(v.query('#artView [data-art="back"]')!.textContent).toBe('← Artifacts');
    scrollTo(v, 900);
    await click(v, '#artView [data-art="back"]');
    expect(v.queryAll('#artView .artrow')).toHaveLength(4);
    expect(scrollTop(v)).toBe(80);
    await click(v, '#artView [data-art="back"]');
    expect(shown(v, '#artView')).toBe(false);
    expect(scrollTop(v)).toBe(500);
    await click(v, '#artifacts [data-art-open="review"]');
    expect(v.query('#artView [data-art="back"]')!.textContent).toBe('← Ticket');
    expect(scrollTop(v)).toBe(900);
    await click(v, '#artView [data-art="back"]');
    expect(surfaces(v)).toEqual([]);
  });

  it('persists artView, artScrolls, sel and srvFilter through setState, React never writing it', async () => {
    const v = await open();
    const filter = v.query<HTMLInputElement>('#srvFilter')!;
    const setter = Object.getOwnPropertyDescriptor(v.window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(filter, 'svc-2');
    filter.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    await drainReactWork(v);
    await click(v, '#rail .pick[data-stage="review"]');
    scrollTo(v, 321);
    await click(v, '#artViewAll');
    scrollTo(v, 17);
    await click(v, '#artView [data-art-open="plan"]');
    expect(persisted(v)).toMatchObject({
      sel: 'review',
      srvFilter: 'svc-2',
      artView: { id: 'plan', from: 'index' },
      artScrolls: { ticket: 321, index: 17, detail: {} },
    });
    expect(persisted(v).state).toBeTruthy();
    await escape(v);
    expect(persisted(v)).toMatchObject({ artView: 'index', artScrolls: { detail: { plan: 0 } } });
  });

  it('restoring from a persisted getState reopens the same artifact view at the same scroll, with sel and the filter', async () => {
    const state = REAL_STATE();
    h = renderWebview('dashboard', {
      persistedState: {
        state,
        sel: 'review',
        shipWait: null,
        srvFilter: 'svc-3',
        artView: { id: 'review', from: 'index' },
        artScrolls: { ticket: 0, index: 12, detail: { review: 640 } },
      },
    });
    await waitForSettingsReady(h);
    await drainReactWork(h);
    expect(shown(h, '#artView')).toBe(true);
    expect(h.document.body.classList.contains('art-nav')).toBe(true);
    expect(h.query('#artView .art-title')!.textContent).toBe('Review');
    expect(h.query('#artView [data-art="back"]')!.textContent).toBe('← Artifacts');
    expect(scrollTop(h)).toBe(640);
    expect(h.query<HTMLInputElement>('#srvFilter')!.value).toBe('svc-3');
    expect(h.queryAll('#rail .pick').filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => (p as HTMLElement).dataset.stage)).toEqual(['review']);
    // Back from the restored detail goes to the restored index, at its remembered scroll.
    await click(h, '#artView [data-art="back"]');
    expect(h.queryAll('#artView .artrow')).toHaveLength(4);
    expect(scrollTop(h)).toBe(12);
    expect(h.errors).toEqual([]);
  });

  it('ignores a persisted view it cannot read and shows the ticket', async () => {
    h = renderWebview('dashboard', { persistedState: { state: REAL_STATE(), artView: 42, artScrolls: null } });
    await waitForSettingsReady(h);
    await drainReactWork(h);
    expect(surfaces(h)).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});

describe('console — the terminal, in the real page', () => {
  class FakeTerminal {
    static made: FakeTerminal[] = [];
    written = '';
    disposed = false;
    opened = false;
    constructor(public opts: Record<string, unknown>) { FakeTerminal.made.push(this); }
    loadAddon(): void {}
    open(): void { this.opened = true; }
    write(s: string): void { this.written += s; }
    dispose(): void { this.disposed = true; }
    scrollPages(): void {}
    scrollToTop(): void {}
    scrollToBottom(): void {}
  }
  class FakeFit { fit(): void {} }

  it('opens, takes the delivered library, writes the host’s output, closes and disposes', async () => {
    FakeTerminal.made = [];
    const v = await open();
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    expect(v.query('#termHost')!.childElementCount).toBe(0); // the library has not arrived
    (v.window as unknown as Record<string, unknown>).Terminal = FakeTerminal;
    (v.window as unknown as Record<string, unknown>).FitAddon = { FitAddon: FakeFit };
    v.receive({ type: 'xterm', js: null });
    await drainReactWork(v);
    expect(FakeTerminal.made).toHaveLength(1);
    expect(FakeTerminal.made[0]!.opened).toBe(true);
    v.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'recorded\n', truncated: false } });
    v.receive({ type: 'stage-output', stage: 'uat', text: 'live\n' });
    await drainReactWork(v);
    expect(FakeTerminal.made[0]!.written).toBe('recorded\nlive\n');
    expect(v.query('#tstatus')!.textContent).toBe('');
    await click(v, '#termView [data-term="close"]');
    expect(FakeTerminal.made[0]!.disposed).toBe(true);
    expect(surfaces(v)).toEqual([]);
    expect(v.query('#termView')!.childElementCount).toBe(0);
    expect(v.errors).toEqual([]);
  });

  it('shows the host’s refusal and nothing else when the library never arrives', async () => {
    const v = await open();
    await click(v, '#inside [data-act="console"][data-console="uat"]:not([data-console-proc])');
    v.receive({ type: 'xterm', js: null });
    await drainReactWork(v);
    expect(v.query('#termHost .blurb')!.textContent).toBe('Console rendering is unavailable in this build.');
  });
});

describe('env editor — an unsaved edit survives a push', () => {
  it('keeps the draft, the field and its caret through a state push and a live repaint', async () => {
    const v = await open();
    await click(v, '#srvOps [data-act="env-overrides-open"]');
    const area = v.query<HTMLTextAreaElement>('[data-env-scope="web"]')!;
    area.focus();
    const setter = Object.getOwnPropertyDescriptor(v.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(area, 'PORT=1\nNEW=2');
    area.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    await drainReactWork(v);
    expect(v.query('[data-env-scope="web"]')!.closest('section')!.querySelector('.msg')!.textContent).toBe('Unsaved changes');
    const pushed = { ...REAL_STATE(), envOverrides: { services: ['web', 'api'], values: { '*': { SHARED: 'no' }, web: { PORT: '5173' } } } };
    v.receive({ type: 'state', state: pushed });
    await drainReactWork(v);
    v.receive({ type: 'state', state: pushed, live: true });
    await drainReactWork(v);
    expect(v.query('[data-env-scope="web"]')).toBe(area);
    expect(area.value).toBe('PORT=1\nNEW=2');
    expect(v.document.activeElement).toBe(area);
    expect(v.query<HTMLTextAreaElement>('[data-env-scope="*"]')!.value).toBe('SHARED=no');
  });

  it('Save posts the scope and the typed body once, and the host’s accepted answer drops the draft', async () => {
    const v = await open();
    await click(v, '#srvOps [data-act="env-overrides-open"]');
    const area = v.query<HTMLTextAreaElement>('[data-env-scope="api"]')!;
    Object.getOwnPropertyDescriptor(v.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'A=1');
    area.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    await drainReactWork(v);
    const before = v.posted.length;
    await click(v, '[data-env-save="api"]');
    await click(v, '[data-env-save="api"]');
    const sent = v.posted.slice(before) as Array<{ type: string; scope: string; text: string; requestId: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'env-overrides-save', scope: 'api', text: 'A=1' });
    expect(v.query('[data-env-save="api"]')!.getAttribute('aria-busy')).toBe('true');
    v.receive({ type: 'action-result', requestId: sent[0]!.requestId, ok: true });
    await drainReactWork(v);
    expect(v.query<HTMLTextAreaElement>('[data-env-scope="api"]')!.value).toBe('');
    expect(v.query('[data-env-scope="api"]')!.closest('section')!.querySelector('.msg')!.textContent).toBe('Saved — applies at the next start.');
    expect(v.query('[data-env-save="api"]')!.hasAttribute('aria-busy')).toBe(false);
  });
});
