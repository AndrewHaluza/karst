// @vitest-environment jsdom
/** Vanilla document delegators and the React Worktrees island must cooperate (outside-click, Escape priority, pending class). */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, pumpRenderRealm, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';

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
