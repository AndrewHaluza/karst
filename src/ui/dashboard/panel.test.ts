import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { DashboardManager, type PanelHost, type FakePanel } from './panel.js';

/** In-memory PanelHost double: records created panels + messages. */
function fakeHost(): { host: PanelHost; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  const host: PanelHost = {
    createPanel: (title) => {
      const messageHandlers: Array<(m: unknown) => void> = [];
      const panel: FakePanel = {
        title,
        revealed: 0,
        disposed: false,
        posted: [],
        icons: [],
        messageHandlers,
        reveal: () => panel.revealed++,
        setIcon: (p) => panel.icons.push(p),
        postMessage: (m) => panel.posted.push(m),
        onDidReceiveMessage: (h) => messageHandlers.push(h),
        onDidDispose: (h) => (panel.disposeHandler = h),
        dispose: () => {
          panel.disposed = true;
          panel.disposeHandler?.();
        },
        emit: (m) => messageHandlers.forEach((h) => h(m)),
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

  it('posts a ship-progress label to the open panel (transient, not a state push)', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host, panels } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);

    mgr.openDashboard(t.id);
    panels[0]!.posted.length = 0; // drop the open-time state push
    mgr.postShipProgress(t.id, 'Pushing branch…');

    expect(panels[0]!.posted).toEqual([{ type: 'ship-progress', label: 'Pushing branch…' }]);
  });

  it('postShipProgress on an unopened ticket is a no-op', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const { host } = fakeHost();
    const mgr = new DashboardManager(store, host, () => ({}) as never);
    expect(() => mgr.postShipProgress(t.id, 'x')).not.toThrow();
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
});
