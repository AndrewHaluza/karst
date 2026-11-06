import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { archiveTicket, createTicket } from '../../store/tickets.js';
import { DashboardManager, type DashboardPanel, type PanelHost } from './panel.js';
import type { RestoredPanel } from '../shared/restoredPanel.js';

interface Spy extends DashboardPanel {
  posted: unknown[];
  icons: string[];
  revealed: number;
}

function spyPanel(): Spy {
  const spy: Spy = {
    posted: [],
    icons: [],
    revealed: 0,
    reveal: () => void spy.revealed++,
    postMessage: (m) => void spy.posted.push(m),
    onDidReceiveMessage: () => {},
    onDidChangeViewState: () => {},
    onDidDispose: () => {},
    setIcon: (p) => void spy.icons.push(p),
  };
  return spy;
}

function restored(): { restored: RestoredPanel<DashboardPanel>; panel: Spy; log: string[] } {
  const panel = spyPanel();
  const log: string[] = [];
  return {
    panel,
    log,
    restored: { wrap: () => (log.push('wrap'), panel), dispose: () => void log.push('dispose') },
  };
}

describe('DashboardManager.adoptDashboard', () => {
  let store: Store;
  let activated: Array<[number, boolean]>;
  let debug: string[];
  let created: number;
  const host: PanelHost = { createPanel: () => (created++, spyPanel()) };
  const manager = (): DashboardManager =>
    new DashboardManager(
      store, host, () => ({}) as never,
      undefined, undefined, undefined, undefined, undefined,
      (id) => `/icons/${id}.svg`,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (id, active) => void activated.push([id, active]),
      undefined, undefined, undefined, undefined, undefined, undefined,
      { debug: (m) => void debug.push(m), isDebugEnabled: () => true },
    );

  beforeEach(() => {
    store = openStore(':memory:');
    activated = [];
    debug = [];
    created = 0;
  });
  afterEach(() => store.close());

  it('adopts a live ticket: wraps, tints the icon, pushes state and the bind, never reveals or focuses', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const m = manager();
    const r = restored();
    expect(m.adoptDashboard(t.id, r.restored)).toBe(true);
    expect(r.log).toEqual(['wrap']);
    expect(r.panel.icons).toEqual([`/icons/${t.id}.svg`]);
    expect(r.panel.posted.map((p) => (p as { type: string }).type)).toEqual(expect.arrayContaining(['state', 'bind']));
    expect(r.panel.revealed).toBe(0);
    expect(activated).toEqual([]);
    expect(created).toBe(0);
  });

  it('a later openDashboard reveals the adopted panel instead of creating a second', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const m = manager();
    const r = restored();
    m.adoptDashboard(t.id, r.restored);
    m.openDashboard(t.id);
    expect(r.panel.revealed).toBe(1);
    expect(created).toBe(0);
  });

  it('closes the tab silently when the ticket is missing', () => {
    const r = restored();
    expect(manager().adoptDashboard(9999, r.restored)).toBe(false);
    expect(r.log).toEqual(['dispose']);
    expect(debug.join('\n')).toContain('missing');
  });

  it('closes the tab silently when the ticket is archived', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    archiveTicket(store, t.id);
    const r = restored();
    expect(manager().adoptDashboard(t.id, r.restored)).toBe(false);
    expect(r.log).toEqual(['dispose']);
    expect(debug.join('\n')).toContain('archived');
  });

  it('closes the duplicate when the ticket already has a panel in this window', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const m = manager();
    const first = restored();
    const second = restored();
    expect(m.adoptDashboard(t.id, first.restored)).toBe(true);
    expect(m.adoptDashboard(t.id, second.restored)).toBe(false);
    expect(second.log).toEqual(['dispose']);
    expect(first.log).toEqual(['wrap']);
  });

  it('closes the tab when the state carried no ticket id', () => {
    const r = restored();
    expect(manager().adoptDashboard(undefined, r.restored)).toBe(false);
    expect(r.log).toEqual(['dispose']);
    expect(debug.join('\n')).toContain('no ticket id');
  });
});
