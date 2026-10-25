// @vitest-environment jsdom
/** Vanilla document delegators and the React Worktrees island must cooperate (outside-click, Escape priority, pending class). */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, pumpRenderRealm, renderWebviewReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor } from '../renderFixtures.js';

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
