import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { SidebarViewManager, type SidebarView, type SidebarViewHost } from './panel.js';
import type { SidebarActions } from './messages.js';
import type { SidebarState } from './state.js';

interface FakeView extends SidebarView {
  posted: SidebarState[];
  handlers: Array<(m: unknown) => void>;
  emit(m: unknown): void;
}

function fakeHost(): { host: SidebarViewHost; resolve: () => FakeView } {
  let handler: ((view: SidebarView) => void) | undefined;
  const host: SidebarViewHost = { onResolve: (h) => (handler = h) };
  const resolve = (): FakeView => {
    const view: FakeView = {
      posted: [],
      handlers: [],
      postMessage: (m) => view.posted.push(m.state),
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
    expect(view.posted[0]!.rows.map((r) => r.label)).toEqual(['A-1 — one']);
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
});
