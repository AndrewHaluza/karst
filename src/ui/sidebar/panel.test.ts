import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { recordEvent } from '../../store/karstEvents.js';
import { ACTIVITY_PAGE } from './activity.js';
import { SidebarViewManager, SIDEBAR_REFRESH_DEBOUNCE_MS, type SidebarView, type SidebarViewHost } from './panel.js';
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
    planCreate: vi.fn(),
    planOpen: vi.fn(),
    planArtifacts: vi.fn(),
    planArchive: vi.fn(),
    planUnarchive: vi.fn(),
    planProposalReview: vi.fn(),
    planProposalDiscard: vi.fn(),
    planProposalPriority: vi.fn(),
    setPriority: vi.fn(),
    shipTicket: vi.fn(),
    retryShip: vi.fn(),
    mergePr: vi.fn(),
    cloudSessionOpen: vi.fn(),
    cloudSessionLink: vi.fn(),
    cloudSessionUnlink: vi.fn(),
    cloudSessionAdd: vi.fn(),
    activityOpen: vi.fn(),
    activityMarkRead: vi.fn(),
    activityMarkAllRead: vi.fn(),
    activityMore: vi.fn(),
    toggleFacet: vi.fn(),
    setFilter: vi.fn(),
    refresh: vi.fn(),
    requestState: vi.fn(),
    create: vi.fn(),
    openSettings: vi.fn(),
    openResources: vi.fn(),
    openTokenUsage: vi.fn(),
    openTicket: vi.fn(),
    openDashboard: vi.fn(),
    spin: vi.fn(),
    openSession: vi.fn(),
    edit: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
    createFollowUp: vi.fn(),
    pauseTicket: vi.fn(),
    unpauseTicket: vi.fn(),
    closeTicket: vi.fn(),
    reopenTicket: vi.fn(),
    detachSubtask: vi.fn(),
    resolveConflicts: vi.fn(),
    sendCiFailure: vi.fn(),
    ...over,
  };
}

describe('SidebarViewManager', () => {
  let store: Store;
  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(':memory:');
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

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
    expect(view.posted).toHaveLength(2); // the refresh repeats the filter push: not posted again
    expect(mgr.getFacets()).toEqual(['archived']);
    expect(view.posted[0]!.facets).toEqual(['archived']);
    expect(view.posted[1]!.filter).toBe('x');
  });

  it('refreshNow answers a state request even when the state equals the last post', () => {
    createTicket(store, { key: 'A-1', title: 'one' });
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    expect(view.posted).toHaveLength(1);

    mgr.refreshNow(); // a reloaded page asked for state: it holds none
    expect(view.posted).toHaveLength(2);
    expect(view.posted[1]).toEqual(view.posted[0]);
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
    createTicket(store, { key: 'B-2', title: 'two' });
    expect(() => mgr.refresh()).not.toThrow();
    vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS);
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

  it('acks the monitor handoffs (resources + token usage) synchronously', async () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    const view = resolve();
    view.emit({ type: 'open-resources', requestId: 'r4' });
    view.emit({ type: 'open-token-usage', requestId: 'r5' });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.postedRaw).toContainEqual({ type: 'action-result', requestId: 'r4', ok: true });
    expect(view.postedRaw).toContainEqual({ type: 'action-result', requestId: 'r5', ok: true });
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

  it('posts the resolved edge line on resolve and on every setEdge', () => {
    const mgr = new SidebarViewManager(store, () => stubActions());
    const { host, resolve } = fakeHost();
    mgr.bind(host);
    mgr.setEdge('left');
    const view = resolve();
    // The initial push carries both the ticket snapshot and the edge side.
    expect(view.postedRaw).toContainEqual({ type: 'edge', side: 'left' });

    mgr.setEdge('none');
    expect(view.postedRaw.at(-1)).toEqual({ type: 'edge', side: 'none' });
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
    vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS);
    expect(view.posted.at(-1)!.sections.current[0]!.isActive).toBe(true);

    active = null;
    mgr.refresh();
    vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS);
    expect(view.posted.at(-1)!.sections.current[0]!.isActive).toBe(false);
  });

  describe('refresh cost', () => {
    /** A view whose visibility the test controls. */
    function visibleHost(): { host: SidebarViewHost; resolve: () => FakeView & { show(v: boolean): void } } {
      let handler: ((view: SidebarView) => void) | undefined;
      const host: SidebarViewHost = { onResolve: (h) => (handler = h) };
      const resolve = () => {
        let visible = true;
        const listeners: Array<() => void> = [];
        const view = {
          posted: [] as SidebarState[],
          postedRaw: [] as SidebarHostMessage[],
          handlers: [] as Array<(m: unknown) => void>,
          postMessage: (m: SidebarHostMessage) => {
            view.postedRaw.push(m);
            if (m.type === 'state') view.posted.push(m.state);
          },
          onDidReceiveMessage: (h: (m: unknown) => void) => view.handlers.push(h),
          emit: (m: unknown) => view.handlers.forEach((h) => h(m)),
          isVisible: () => visible,
          onDidChangeVisibility: (h: () => void) => listeners.push(h),
          show: (v: boolean) => {
            visible = v;
            listeners.forEach((l) => l());
          },
        };
        handler!(view);
        return view;
      };
      return { host, resolve };
    }

    it('many refresh calls inside the debounce window produce one build', () => {
      const debug = vi.fn();
      const mgr = new SidebarViewManager(store, () => stubActions(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { debug });
      const { host, resolve } = visibleHost();
      mgr.bind(host);
      const view = resolve();
      debug.mockClear();
      createTicket(store, { key: 'N-1', title: 'new' });
      for (let i = 0; i < 25; i++) {
        mgr.refresh();
        vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS - 1);
      }
      expect(debug).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0]![0]).toMatch(/^\[sidebar\] buildSidebarState/);
      expect(view.posted).toHaveLength(2);
    });

    it('a hidden view builds nothing, and the next show pushes once', () => {
      const debug = vi.fn();
      const mgr = new SidebarViewManager(store, () => stubActions(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { debug });
      const { host, resolve } = visibleHost();
      mgr.bind(host);
      const view = resolve();
      view.show(false);
      debug.mockClear();
      const before = view.posted.length;
      createTicket(store, { key: 'H-1', title: 'hidden' });
      mgr.refresh();
      mgr.setFilter('h');
      vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS * 2);
      expect(debug).not.toHaveBeenCalled();
      expect(view.posted).toHaveLength(before);
      view.show(true);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(view.posted).toHaveLength(before + 1);
      expect(view.posted.at(-1)!.filter).toBe('h');
    });

    it('showing a view with nothing missed builds nothing', () => {
      const debug = vi.fn();
      const mgr = new SidebarViewManager(store, () => stubActions(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { debug });
      const { host, resolve } = visibleHost();
      mgr.bind(host);
      const view = resolve();
      debug.mockClear();
      view.show(false);
      view.show(true);
      expect(debug).not.toHaveBeenCalled();
    });

    it('does not post a state identical to the last post', () => {
      const mgr = new SidebarViewManager(store, () => stubActions());
      const { host, resolve } = visibleHost();
      mgr.bind(host);
      const view = resolve();
      const before = view.postedRaw.length;
      mgr.refresh();
      vi.advanceTimersByTime(SIDEBAR_REFRESH_DEBOUNCE_MS);
      expect(view.postedRaw).toHaveLength(before);
    });

    it('a re-resolved view gets the state again even when it is unchanged', () => {
      const mgr = new SidebarViewManager(store, () => stubActions());
      const { host, resolve } = visibleHost();
      mgr.bind(host);
      resolve();
      const second = resolve();
      expect(second.posted).toHaveLength(1);
    });
  });

  describe('Activity pane', () => {
    const seed = (n: number): number => {
      const projectId = upsertProject(store, { slug: 'pa' }).id;
      for (let i = 0; i < n; i++) recordEvent(store, { projectId, level: 'info', source: 'host', title: `e${i}` }, () => undefined);
      return projectId;
    };
    const mk = (projectId: number) => new SidebarViewManager(store, () => stubActions(), undefined, undefined, undefined, () => projectId);

    it('puts the bound project\'s newest rows in the state', () => {
      const mgr = mk(seed(3));
      const { host, resolve } = fakeHost();
      mgr.bind(host);
      expect(resolve().posted[0]!.activity).toMatchObject({ total: 3, unread: 3, hasMore: false });
    });

    it('showMoreActivity grows the page only for the oldest shown row', () => {
      const mgr = mk(seed(ACTIVITY_PAGE + 5));
      const { host, resolve } = fakeHost();
      mgr.bind(host);
      const view = resolve();
      const first = view.posted[0]!.activity;
      expect(first.rows).toHaveLength(ACTIVITY_PAGE);
      mgr.showMoreActivity(first.rows[0]!.id);
      expect(view.posted).toHaveLength(1);
      mgr.showMoreActivity(first.rows[ACTIVITY_PAGE - 1]!.id);
      expect(view.posted[1]!.activity).toMatchObject({ hasMore: false });
      expect(view.posted[1]!.activity.rows).toHaveLength(ACTIVITY_PAGE + 5);
      mgr.showMoreActivity(1);
      expect(view.posted).toHaveLength(2);
    });

    it('starts at one page again when the bound project changes', () => {
      const a = seed(ACTIVITY_PAGE + 5);
      const b = upsertProject(store, { slug: 'pb' }).id;
      for (let i = 0; i < ACTIVITY_PAGE + 5; i++) recordEvent(store, { projectId: b, level: 'info', source: 'host', title: `b${i}` }, () => undefined);
      let bound = a;
      const mgr = new SidebarViewManager(store, () => stubActions(), undefined, undefined, undefined, () => bound);
      const { host, resolve } = fakeHost();
      mgr.bind(host);
      const view = resolve();
      mgr.showMoreActivity(view.posted[0]!.activity.rows[ACTIVITY_PAGE - 1]!.id);
      expect(view.posted[1]!.activity.rows).toHaveLength(ACTIVITY_PAGE + 5);
      bound = b;
      (mgr as unknown as { push(): void }).push();
      expect(view.posted[2]!.activity.rows).toHaveLength(ACTIVITY_PAGE);
    });

    it('revealActivity posts at once on a resolved view', () => {
      const mgr = mk(seed(0));
      const { host, resolve } = fakeHost();
      mgr.bind(host);
      const view = resolve();
      mgr.revealActivity();
      expect(view.postedRaw.filter((m) => m.type === 'reveal-activity')).toHaveLength(1);
    });

    it('revealActivity before the view resolves is held and posted once after the first state', () => {
      const mgr = mk(seed(0));
      const { host, resolve } = fakeHost();
      mgr.bind(host);
      mgr.revealActivity();
      const view = resolve();
      const types = view.postedRaw.map((m) => m.type);
      expect(types.filter((t) => t === 'reveal-activity')).toHaveLength(1);
      expect(types.indexOf('reveal-activity')).toBeGreaterThan(types.indexOf('state'));
      mgr.refresh();
      expect(view.postedRaw.filter((m) => m.type === 'reveal-activity')).toHaveLength(1);
    });
  });
});
