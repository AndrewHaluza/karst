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
    setFacet: vi.fn(),
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

  it('setFacet / setFilter / refresh each re-push and getFacet reflects the pick', () => {
    createTicket(store, { key: 'A-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.posted.length = 0;

    mgr.setFacet('archived');
    mgr.setFilter('x');
    mgr.refresh();
    expect(view.posted).toHaveLength(3);
    expect(mgr.getFacet()).toBe('archived');
    expect(view.posted[0]!.facet).toBe('archived');
    expect(view.posted[1]!.filter).toBe('x');
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
});
