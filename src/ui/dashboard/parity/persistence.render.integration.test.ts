// @vitest-environment jsdom
/**
 * The switch-over (migration Phase 12): the React app is the page's only script, so it owns the view-state persistence,
 * the restore and the settling of the runtime's pending requests. These tests run the real page. They pin the envelope
 * the retired page script wrote (`vscode.setState`), the restore of an envelope and of the bare snapshot an older build
 * wrote, the triggers (a live repaint writes nothing), and that no host message is lost between page load and mount.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebview, waitForSettingsReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';

let h: RenderHandle | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

const FRESH_SCROLLS = { ticket: 0, index: 0, detail: {} };
const stage = (v: RenderHandle): string[] =>
  v.queryAll('#rail .pick').filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => (p as HTMLElement).dataset.stage!);

async function boot(persistedState?: unknown): Promise<RenderHandle> {
  h = renderWebview('dashboard', { persistedState });
  await waitForSettingsReady(h);
  await drainReactWork(h);
  return h;
}

/** What the retired page script persisted: the exact keys, in its order. */
const OLD_ENVELOPE = (state: DashboardState): Record<string, unknown> => ({
  state,
  sel: 'uat',
  shipWait: null,
  srvFilter: '',
  artView: null,
  artScrolls: { ticket: 0, index: 0, detail: {} },
});

describe('view-state persistence — written by the React app, in the envelope the old page wrote', () => {
  it('writes nothing until the host pushes, and the push writes the whole envelope', async () => {
    const v = await boot();
    expect(v.state).toBeUndefined();
    const state = populatedStateFor('impl');
    v.receive({ type: 'state', state });
    await drainReactWork(v);
    expect(v.state).toEqual({ state, sel: null, shipWait: null, srvFilter: '', artView: null, artScrolls: FRESH_SCROLLS });
    expect(Object.keys(v.state as object)).toEqual(['state', 'sel', 'shipWait', 'srvFilter', 'artView', 'artScrolls']);
  });

  it('does not write for a live repaint, and the next real push carries the repainted snapshot', async () => {
    const v = await boot();
    const first = populatedStateFor('impl');
    v.receive({ type: 'state', state: first });
    await drainReactWork(v);
    const written = v.state;
    const repainted = { ...first, title: 'Live repaint' } as DashboardState;
    v.receive({ type: 'state', state: repainted, live: true });
    await drainReactWork(v);
    expect(v.state).toBe(written);
    const next = { ...first, title: 'Next push' } as DashboardState;
    v.receive({ type: 'state', state: next });
    await drainReactWork(v);
    expect((v.state as { state: DashboardState }).state).toEqual(next);
  });

  it('writes the selection, the filter and nothing else new when they change', async () => {
    const v = await boot();
    v.receive({ type: 'state', state: populatedStateFor('impl') });
    await drainReactWork(v);
    v.click('#rail .pick[data-stage="uat"]');
    await drainReactWork(v);
    expect(v.state).toMatchObject({ sel: 'uat', srvFilter: '', artView: null });
  });
});

describe('view-state restore — an envelope, and the bare snapshot of an older build', () => {
  it('restores what the old page persisted (the snapshot shows, the selection holds) and writes it back unchanged', async () => {
    const state = populatedStateFor('impl');
    const v = await boot(OLD_ENVELOPE(state));
    expect(stage(v)).toEqual(['uat']);
    expect(v.errors).toEqual([]);
    // The restore itself writes nothing; the first real push writes the envelope again, selection intact.
    expect(v.state).toEqual(OLD_ENVELOPE(state));
    const pushed = populatedStateFor('impl');
    v.receive({ type: 'state', state: pushed });
    await drainReactWork(v);
    expect(v.state).toEqual({ ...OLD_ENVELOPE(state), state: pushed });
  });

  it('shows a snapshot persisted bare by a build from before the envelope, and upgrades it on the next push', async () => {
    const state = populatedStateFor('impl');
    const v = await boot(state);
    expect(stage(v)).toEqual(['impl']);
    expect(v.state).toBe(state);
    v.receive({ type: 'state', state });
    await drainReactWork(v);
    expect(v.state).toEqual({ state, sel: null, shipWait: null, srvFilter: '', artView: null, artScrolls: FRESH_SCROLLS });
    expect(v.errors).toEqual([]);
  });

  it('starts empty from an unreadable persisted value', async () => {
    const v = await boot('garbage');
    expect(stage(v)).toEqual([]);
    expect(v.errors).toEqual([]);
  });
});

describe('host messages between page load and mount', () => {
  it('a snapshot that lands before React has mounted is shown and persisted, and an action-result settles the runtime', async () => {
    h = renderWebview('dashboard');
    const settled: unknown[][] = [];
    (h.window as unknown as { karstSettle: (...args: unknown[]) => void }).karstSettle = (...args) => void settled.push(args);
    const state = populatedStateFor('impl');
    // The script has run (the page's listener is attached) but React has not committed yet.
    expect(h.document.documentElement.hasAttribute('data-karst-ready')).toBe(false);
    h.receive({ type: 'state', state });
    h.receive({ type: 'action-result', requestId: 'early', ok: false, message: 'Refused.' });
    await waitForSettingsReady(h);
    expect(stage(h)).toEqual(['impl']);
    expect(h.state).toMatchObject({ state });
    expect(settled).toEqual([['early', false, 'Refused.']]);
    expect(h.errors).toEqual([]);
  });

  it('is ready only with the first state in the DOM', async () => {
    h = renderWebview('dashboard');
    h.receive({ type: 'state', state: populatedStateFor('impl') });
    await waitForSettingsReady(h);
    expect(h.document.documentElement.hasAttribute('data-karst-ready')).toBe(true);
    expect(stage(h)).toEqual(['impl']);
  });

  it('settles a later action-result once, without a second listener on the page', async () => {
    const v = await boot();
    const settled: unknown[][] = [];
    (v.window as unknown as { karstSettle: (...args: unknown[]) => void }).karstSettle = (...args) => void settled.push(args);
    v.receive({ type: 'action-result', requestId: 'r1', ok: true });
    await drainReactWork(v);
    expect(settled).toEqual([['r1', true, undefined]]);
  });
});
