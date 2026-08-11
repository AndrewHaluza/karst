import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { SidebarViewManager, type SidebarView, type SidebarViewHost } from './panel.js';
import type { SidebarActions, SidebarHostMessage } from './messages.js';
import type { SidebarState } from './state.js';

interface FakeView extends SidebarView {
  /** Every posted `state` snapshot (kept separate for the pre-existing state-shaped assertions below). */
  posted: SidebarState[];
  /** Every message posted, `state` included — needed to see `action-result`. */
  postedRaw: SidebarHostMessage[];
  handlers: Array<(m: unknown) => void>;
  emit(m: unknown): void;
}

function fakeHost(): { host: SidebarViewHost; resolve: () => FakeView } {
  let handler: ((view: SidebarView) => void) | undefined;
  const host: SidebarViewHost = { onResolve: (h) => (handler = h) };
  const resolve = (): FakeView => {
    const view: FakeView = {
      posted: [],
      postedRaw: [],
      handlers: [],
      postMessage: (m) => {
        view.postedRaw.push(m);
        if (m.type === 'state') view.posted.push(m.state);
      },
      onDidReceiveMessage: (h) => view.handlers.push(h),
      emit: (m) => view.handlers.forEach((h) => h(m)),
    };
    handler!(view);
    return view;
  };
  return { host, resolve };
}

function stubActions(over: Partial<SidebarActions> = {}): SidebarActions {
  return {
    toggleFacet: vi.fn(),
    setFilter: vi.fn(),
    refresh: vi.fn(),
    requestState: vi.fn(),
    create: vi.fn(),
    openSettings: vi.fn(),
    openTicket: vi.fn(),
    openDashboard: vi.fn(),
    spin: vi.fn(),
    openSession: vi.fn(),
    edit: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
    ...over,
  };
}

describe('SidebarViewManager', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('pushes initial state when the view resolves', () => {
    createTicket(store, { key: 'A-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    expect(view.posted).toHaveLength(1);
    expect(view.posted[0]!.sections.current.map((r) => r.label)).toEqual(['A-1 — one']);
  });

  it('toggleFacet / setFilter / refresh each re-push and getFacets reflects the pick', () => {
    createTicket(store, { key: 'A-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.posted.length = 0;

    mgr.toggleFacet('archived');
    mgr.setFilter('x');
    mgr.refresh();
    expect(view.posted).toHaveLength(3);
    expect(mgr.getFacets()).toEqual(['archived']);
    expect(view.posted[0]!.facets).toEqual(['archived']);
    expect(view.posted[1]!.filter).toBe('x');
  });

  it('toggleFacet builds a multi-status union and getFacets reflects it', () => {
    createTicket(store, { key: 'A-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.posted.length = 0;

    mgr.toggleFacet('running');
    mgr.toggleFacet('failed');
    expect(mgr.getFacets()).toEqual(['running', 'failed']);
    expect(view.posted.at(-1)!.facets).toEqual(['running', 'failed']);

    mgr.toggleFacet('running'); // toggle one off
    expect(mgr.getFacets()).toEqual(['failed']);
  });

  it('routes an inbound message to the matching action', () => {
    const spin = vi.fn();
    const mgr = new SidebarViewManager(store, () => stubActions({ spin }));
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.emit({ type: 'spin', ticketId: 42 });
    expect(spin).toHaveBeenCalledWith(42);
  });

  it('a push before resolve is a safe no-op', () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    expect(() => mgr.refresh()).not.toThrow();
  });

  it('notifies the refresh subscriber on every refresh', () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    resolve();
    const seen = vi.fn();
    mgr.onRefresh(seen);
    mgr.refresh();
    mgr.refresh();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('notifies the refresh subscriber even before the view resolves', () => {
    // The badge is most useful in exactly this window: the user has never
    // opened the Tickets view, so `push` is a no-op — but the count still needs
    // to reach the activity-bar icon.
    const mgr = new SidebarViewManager(store, () => stubActions());
    const seen = vi.fn();
    mgr.onRefresh(seen);
    mgr.refresh();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does not notify on filter or facet changes — the ticket set is unchanged', () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    resolve();
    const seen = vi.fn();
    mgr.onRefresh(seen);
    mgr.setFilter('abc');
    mgr.toggleFacet('failed');
    expect(seen).not.toHaveBeenCalled();
  });

  it('still refreshes when no subscriber is registered', () => {
    createTicket(store, { key: 'B-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    const before = view.posted.length;
    expect(() => mgr.refresh()).not.toThrow();
    expect(view.posted.length).toBe(before + 1);
  });

  it('posts exactly one action-result per parsed request that carries a requestId (UI-R13)', async () => {
    const spin = vi.fn();
    const mgr = new SidebarViewManager(store, () => stubActions({ spin }));
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.emit({ type: 'spin', ticketId: 7, requestId: 'r1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(spin).toHaveBeenCalledWith(7);
    const results = view.postedRaw.filter((m) => m.type === 'action-result');
    expect(results).toEqual([{ type: 'action-result', requestId: 'r1', ok: true }]);
  });

  it('posts no action-result for a message with no requestId (back-compat)', async () => {
    const spin = vi.fn();
    const mgr = new SidebarViewManager(store, () => stubActions({ spin }));
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.emit({ type: 'spin', ticketId: 7 });
    await Promise.resolve();
    await Promise.resolve();
    expect(spin).toHaveBeenCalledWith(7);
    expect(view.postedRaw.some((m) => m.type === 'action-result')).toBe(false);
  });

  it('reports a rejected action as ok:false with its message, and logs it', async () => {
    const logError = vi.fn();
    const mgr = new SidebarViewManager(
      store,
      () => stubActions({ delete: vi.fn().mockRejectedValue(new Error('locked')) }),
      undefined,
      undefined,
      logError,
    );
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.emit({ type: 'delete', ticketId: 9, requestId: 'r2' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const results = view.postedRaw.filter((m) => m.type === 'action-result');
    expect(results).toEqual([{ type: 'action-result', requestId: 'r2', ok: false, message: 'locked' }]);
    expect(logError).toHaveBeenCalledWith('karst: sidebar action failed', expect.any(Error));
  });

  it('acks a void action synchronously (handoff kind)', async () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.emit({ type: 'open-settings', requestId: 'r3' });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.postedRaw).toContainEqual({ type: 'action-result', requestId: 'r3', ok: true });
  });

  it('routes messages to actions and survives a bad message without throwing or reporting', () => {
    const spin = vi.fn();
    const logError = vi.fn();
    const mgr = new SidebarViewManager(store, () => stubActions({ spin }), undefined, undefined, logError);
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    expect(() => view.emit({ type: 'spin', ticketId: 3 })).not.toThrow();
    expect(() => view.emit({ type: 'evil' })).not.toThrow();
    expect(spin).toHaveBeenCalledWith(3);
    expect(logError).not.toHaveBeenCalled();
  });

  it('marks the row whose ticket view is the ACTIVE view, read live from the injected getter', () => {
    const t = createTicket(store, { key: 'A-1', title: 'one' });
    let active: number | null = null;
    const mgr = new SidebarViewManager(
      store, () => stubActions(), undefined, undefined, undefined, undefined, undefined,
      () => active,
    );
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    expect(view.posted[0]!.sections.current[0]!.isActive).toBe(false);

    active = t.id;
    mgr.refresh();
    expect(view.posted.at(-1)!.sections.current[0]!.isActive).toBe(true);

    active = null;
    mgr.refresh();
    expect(view.posted.at(-1)!.sections.current[0]!.isActive).toBe(false);
  });
});
