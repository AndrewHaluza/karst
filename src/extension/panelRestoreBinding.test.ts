import { describe, expect, it, vi } from 'vitest';
import { RESTORED_VIEW_TYPES, RestoreGate } from './panelRestore.js';
import { makeRestorers, registerRestoreSerializers } from './panelRestoreBinding.js';
import { openStore } from '../store/db.js';
import { archiveTicket, createTicket } from '../store/tickets.js';

const raw = { dispose: vi.fn() };

describe('registerRestoreSerializers', () => {
  it('routes a deserialized panel of each view type through the gate with its state', async () => {
    const gate = new RestoreGate();
    const serializers = new Map<string, { deserializeWebviewPanel(panel: never, state: unknown): Thenable<void> }>();
    registerRestoreSerializers({ registerWebviewPanelSerializer: (t, s) => void serializers.set(t, s) }, gate);
    const seen: Array<[string, unknown, unknown]> = [];
    gate.open(Object.fromEntries(RESTORED_VIEW_TYPES.map((t) => [t, (r: unknown, st: unknown) => void seen.push([t, r, st])])));
    for (const t of RESTORED_VIEW_TYPES) await serializers.get(t)!.deserializeWebviewPanel(raw as never, { s: t });
    expect(seen).toEqual(RESTORED_VIEW_TYPES.map((t) => [t, raw, { s: t }]));
  });

  it('returns the disposables the window gave back', () => {
    const out = registerRestoreSerializers({ registerWebviewPanelSerializer: (t) => `d:${t}` }, new RestoreGate());
    expect(out).toEqual(RESTORED_VIEW_TYPES.map((t) => `d:${t}`));
  });
});

describe('makeRestorers', () => {
  const setup = () => {
    const store = openStore(':memory:');
    const live = createTicket(store, { key: 'K-1', title: 't' });
    const old = createTicket(store, { key: 'K-2', title: 't' });
    archiveTicket(store, old.id);
    const calls: unknown[][] = [];
    const rec = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
    const wrapped = (name: string) => ({ restore: (r: unknown) => ({ name, r }) as never });
    const manager = (name: string) => ({ adopt: rec(`${name}.adopt`), adoptDashboard: rec(`${name}.adoptDashboard`) });
    const restorers = makeRestorers({
      store,
      dashboard: manager('dashboard'), dashboardHost: wrapped('dashboardHost'),
      changes: manager('changes'), changesHost: wrapped('changesHost'),
      ticketForm: manager('ticketForm'), ticketFormHost: wrapped('ticketFormHost'),
      settings: manager('settings'), settingsHost: wrapped('settingsHost'),
      gettingStarted: manager('gs'), gettingStartedHost: wrapped('gsHost'),
      doctor: { restore: async (r) => void calls.push(['doctor', r]) },
      usage: manager('usage'), usageHost: wrapped('usageHost'),
      resources: manager('resources'), resourcesHost: wrapped('resourcesHost'),
    });
    return { restorers, calls, live, old };
  };
  const state = (ticketId: number) => ({ karstPanel: { ticketId } });

  it('adopts a dashboard with the ticket id from the state and the wrapped host panel', async () => {
    const { restorers, calls } = setup();
    await restorers['karst.dashboard']!(raw, state(4));
    expect(calls).toEqual([['dashboard.adoptDashboard', 4, { name: 'dashboardHost', r: raw }]]);
  });

  it('passes no ticket id for a state without the key', async () => {
    const { restorers, calls } = setup();
    await restorers['karst.dashboard']!(raw, {});
    expect(calls[0]![1]).toBeUndefined();
  });

  it('adopts a changes tab with a liveness check over the store', async () => {
    const { restorers, calls, live, old } = setup();
    await restorers['karst.changes']!(raw, state(live.id));
    const [, id, panel, exists] = calls[0] as [string, number, unknown, (n: number) => boolean];
    expect(id).toBe(live.id);
    expect(panel).toEqual({ name: 'changesHost', r: raw });
    expect([exists(live.id), exists(old.id), exists(999)]).toEqual([true, false, false]);
  });

  it('adopts a ticket form with the raw saved state and a liveness check over the store', async () => {
    const { restorers, calls, live, old } = setup();
    const saved = { karstPanel: { mode: 'edit', ticketId: live.id }, draft: { title: 'x' } };
    await restorers['karst.ticketForm']!(raw, saved);
    const [name, panel, passed, exists] = calls[0] as [string, unknown, unknown, (n: number) => boolean];
    expect(name).toBe('ticketForm.adopt');
    expect(panel).toEqual({ name: 'ticketFormHost', r: raw });
    expect(passed).toBe(saved);
    expect([exists(live.id), exists(old.id), exists(999)]).toEqual([true, false, false]);
  });

  it('closes a restored ticket form when the manifest does not load, and adopts it when it does', async () => {
    const mk = (ready: boolean) => {
      const closed: unknown[] = [];
      const adopted: unknown[][] = [];
      const prefill = (): unknown => undefined;
      const outcome = (): unknown => undefined;
      const restorers = makeRestorers({
        store: openStore(':memory:'),
        ticketForm: { adopt: (...a: unknown[]) => void adopted.push(a) },
        ticketFormHost: { restore: () => ({ wrap: () => ({}), dispose: () => void closed.push(1) }) as never },
        manifestReady: () => ready,
        proposalPrefill: prefill,
        proposalOutcome: outcome,
      } as never);
      return { restorers, closed, adopted, prefill, outcome };
    };
    const off = mk(false);
    await off.restorers['karst.ticketForm']!({} as never, { karstPanel: { mode: 'create' } });
    expect(off.closed).toHaveLength(1);
    expect(off.adopted).toHaveLength(0);
    const on = mk(true);
    await on.restorers['karst.ticketForm']!({} as never, { karstPanel: { mode: 'create' } });
    expect(on.closed).toHaveLength(0);
    expect(on.adopted[0]![3]).toBe(on.prefill);
    expect(on.adopted[0]![4]).toBe(on.outcome);
  });

  it('forwards the restored webview state to usage.adopt', async () => {
    const { restorers, calls } = setup();
    await restorers['karst.tokenUsage']!(raw, { tab: 'quota' });
    expect(calls).toEqual([['usage.adopt', { name: 'usageHost', r: raw }, { tab: 'quota' }]]);
  });

  it('adopts each singleton and the doctor with the raw panel', async () => {
    const { restorers, calls } = setup();
    await restorers['karst.settings']!(raw, null);
    await restorers['karst.gettingStarted']!(raw, null);
    await restorers.karstDoctor!(raw, null);
    await restorers['karst.tokenUsage']!(raw, null);
    await restorers['karst.resources']!(raw, null);
    expect(calls).toEqual([
      ['settings.adopt', { name: 'settingsHost', r: raw }],
      ['gs.adopt', { name: 'gsHost', r: raw }],
      ['doctor', raw],
      ['usage.adopt', { name: 'usageHost', r: raw }, null],
      ['resources.adopt', { name: 'resourcesHost', r: raw }],
    ]);
  });
});
