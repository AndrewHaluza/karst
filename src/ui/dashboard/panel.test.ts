import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { DashboardManager, type PanelHost, type FakePanel } from './panel.js';
import type { ShipStepEvent } from '../../workflow/stages/ship.js';

/** In-memory PanelHost double: records created panels + messages. */
function fakeHost(): { host: PanelHost; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  const host: PanelHost = {
    createPanel: (title, _ticketId, preserveFocus) => {
      const messageHandlers: Array<(m: unknown) => void> = [];
      const viewStateHandlers: Array<(active: boolean) => void> = [];
      const panel: FakePanel = {
        title,
        revealed: 0,
        createdPreserveFocus: preserveFocus,
        revealedPreserveFocus: [],
        disposed: false,
        posted: [],
        icons: [],
        messageHandlers,
        viewStateHandlers,
        reveal: (keepFocus) => {
          panel.revealed++;
          panel.revealedPreserveFocus.push(keepFocus);
        },
        setIcon: (p) => panel.icons.push(p),
        postMessage: (m) => panel.posted.push(m),
        onDidReceiveMessage: (h) => messageHandlers.push(h),
        onDidChangeViewState: (h) => viewStateHandlers.push(h),
        onDidDispose: (h) => (panel.disposeHandler = h),
        dispose: () => {
          panel.disposed = true;
          panel.disposeHandler?.();
        },
        emit: (m) => messageHandlers.forEach((h) => h(m)),
        emitViewState: (active) => viewStateHandlers.forEach((h) => h(active)),
      };
      panels.push(panel);
      return panel;
    },
  };
  return { host, panels };
}

describe('DashboardManager', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('opening the same ticket twice reveals the existing panel (one per id)', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    mgr.openDashboard(t.id);

    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBeGreaterThanOrEqual(1);
  });

  it('titles the panel with the ticket key + title, not the raw id', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'ship it' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    expect(panels[0]!.title).toBe('PROJ-9 — ship it');
  });

  it('sets the tab icon on open and on each state push, from iconFor', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'ship it' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(
      store,
      host,
      () => ({}) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => '/store/icons/karst-blue.svg',
    );

    mgr.openDashboard(t.id);
    mgr.pushState(t.id);

    expect(panels[0]!.icons).toContain('/store/icons/karst-blue.svg');
    // Open pushes state once, then the explicit push — the icon re-points each time.
    expect(panels[0]!.icons.length).toBeGreaterThanOrEqual(2);
  });

  it('separate tickets get separate panels', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(a.id);
    mgr.openDashboard(b.id);
    expect(panels).toHaveLength(2);
  });

  it('opening a dashboard pushes initial state to the webview', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    const stateMsgs = panels[0]!.posted.filter((m: any) => m.type === 'state');
    expect(stateMsgs).toHaveLength(1);
    expect((stateMsgs[0] as any).state.ticketId).toBe(t.id);
  });

  it('pushState(ticketId) posts a fresh state message to that ticket panel only', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    mgr.openDashboard(a.id);
    mgr.openDashboard(b.id);

    const before = panels[1]!.posted.length;
    mgr.pushState(a.id);
    expect(panels[0]!.posted.filter((m: any) => m.type === 'state')).toHaveLength(2);
    expect(panels[1]!.posted.length).toBe(before); // b untouched
  });

  it('pushState on an unopened ticket is a no-op', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    expect(() => mgr.pushState(t.id)).not.toThrow();
  });

  it('a stop-server webview message dispatches to the supervisor action', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const stopServer = vi.fn();
    const mgr = new DashboardManager(store, host, () => ({ stopServer }) as never);

    mgr.openDashboard(t.id);
    panels[0]!.emit({ type: 'stop-server', serverId: 9 });
    expect(stopServer).toHaveBeenCalledWith(9);
  });

  it('posts a ship-progress event to the open panel (transient, not a state push)', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    const event: ShipStepEvent = { repo: '/repo/a', step: 'push', status: 'run' };

    mgr.openDashboard(t.id);
    panels[0]!.posted.length = 0; // drop the open-time state push
    mgr.postShipProgress(t.id, event);

    expect(panels[0]!.posted).toEqual([{ type: 'ship-progress', event }]);
  });

  it('postShipProgress on an unopened ticket is a no-op', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    expect(() =>
      mgr.postShipProgress(t.id, { repo: '/repo/a', step: 'push', status: 'run' }),
    ).not.toThrow();
  });

  it('disposing a panel drops it from the map so reopen creates a new one', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    panels[0]!.dispose();
    mgr.openDashboard(t.id);
    expect(panels).toHaveLength(2);
  });

  describe('terminal binding', () => {
    const bind = (
      enabled: boolean,
      onDidActivate: (ticketId: number, active: boolean) => void = () => {},
    ) => ({ enabled: () => enabled, onDidActivate });

    it('tells a new panel where the binding currently sits', () => {
      // The preference is host-owned and window-wide, so the webview renders
      // what it is pushed rather than remembering its own copy.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        bind(true),
      );

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted).toContainEqual({ type: 'bind', enabled: true });
    });

    it('reports unbound when the host declares no binding at all', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      expect(panels[0]!.posted).toContainEqual({ type: 'bind', enabled: false });
    });

    it('pushBind reaches every open panel, not just the one that toggled', () => {
      const a = createTicket(store, { key: 'A', title: 'a' });
      const b = createTicket(store, { key: 'B', title: 'b' });
      const { host, panels } = fakeHost();
      let on = false;
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { enabled: () => on, onDidActivate: () => {} },
      );

      mgr.openDashboard(a.id);
      mgr.openDashboard(b.id);
      on = true;
      mgr.pushBind();

      for (const panel of panels) {
        expect(panel.posted).toContainEqual({ type: 'bind', enabled: true });
      }
    });

    it('forwards panel activation, both gaining and losing it', () => {
      // Losing activation is forwarded rather than filtered here: the panel
      // reports what happened, the binder decides what it means.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const seen: Array<[number, boolean]> = [];
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        bind(true, (ticketId, active) => seen.push([ticketId, active])),
      );

      mgr.openDashboard(t.id);
      panels[0]!.emitViewState(true);
      panels[0]!.emitViewState(false);

      expect(seen).toEqual([[t.id, true], [t.id, false]]);
    });

    it('creates and reveals without focus when the binding asked for it', () => {
      // A bound reveal happens because the user clicked the TERMINAL. Taking
      // focus would yank the caret out of the shell they are typing into.
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(panels[0]!.createdPreserveFocus).toBe(true);

      mgr.openDashboard(t.id, { preserveFocus: true });
      expect(panels[0]!.revealedPreserveFocus).toEqual([true]);
    });

    it('takes focus on an ordinary open, as it always did', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      const { host, panels } = fakeHost();
      const mgr = new DashboardManager(store, host, () => ({}) as never);

      mgr.openDashboard(t.id);
      mgr.openDashboard(t.id);

      expect(panels[0]!.createdPreserveFocus).toBeUndefined();
      expect(panels[0]!.revealedPreserveFocus).toEqual([undefined]);
    });
  });
});
