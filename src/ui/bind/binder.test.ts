import { describe, it, expect } from 'vitest';
import { TerminalDashboardBinder, type BinderDeps } from './binder.js';

interface Recorder {
  deps: BinderDeps;
  persisted: boolean[];
  broadcast: boolean[];
  dashboards: number[];
  terminals: number[];
  enabled: boolean;
}

function recorder(initial = false): Recorder {
  const rec: Recorder = {
    enabled: initial,
    persisted: [],
    broadcast: [],
    dashboards: [],
    terminals: [],
    deps: undefined as unknown as BinderDeps,
  };
  rec.deps = {
    isEnabled: () => rec.enabled,
    persist: (v) => {
      rec.enabled = v;
      rec.persisted.push(v);
    },
    revealDashboard: (id) => rec.dashboards.push(id),
    revealTerminal: (id) => rec.terminals.push(id),
    broadcast: (v) => rec.broadcast.push(v),
  };
  return rec;
}

describe('TerminalDashboardBinder', () => {
  it('is off until the user turns it on', () => {
    const rec = recorder();
    const binder = new TerminalDashboardBinder(rec.deps);
    expect(binder.enabled()).toBe(false);
  });

  it('flips, persists and broadcasts on toggle', () => {
    const rec = recorder();
    const binder = new TerminalDashboardBinder(rec.deps);

    binder.toggle();
    expect(binder.enabled()).toBe(true);
    expect(rec.persisted).toEqual([true]);
    // Every open dashboard must agree: the preference is window-wide, so a
    // toggle on one panel cannot leave the others rendering the old state.
    expect(rec.broadcast).toEqual([true]);

    binder.toggle();
    expect(binder.enabled()).toBe(false);
    expect(rec.persisted).toEqual([true, false]);
    expect(rec.broadcast).toEqual([true, false]);
  });

  it('adopts the persisted value, so a reload keeps the binding', () => {
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);
    expect(binder.enabled()).toBe(true);
  });

  it('reveals the dashboard when a bound terminal is activated', () => {
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onTerminalActivated(7);
    expect(rec.dashboards).toEqual([7]);
  });

  it('reveals the terminal when a bound dashboard is activated', () => {
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onDashboardActivated(7, true);
    expect(rec.terminals).toEqual([7]);
  });

  it('does nothing in either direction while unbound', () => {
    const rec = recorder(false);
    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onTerminalActivated(7);
    binder.onDashboardActivated(7, true);
    expect(rec.dashboards).toEqual([]);
    expect(rec.terminals).toEqual([]);
  });

  it('ignores a terminal that carries no ticket id', () => {
    // Every non-Karst terminal in the window raises the same activation event.
    // Without a ticket there is nothing to reveal, and guessing would open an
    // unrelated ticket's dashboard.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onTerminalActivated(undefined);
    expect(rec.dashboards).toEqual([]);
  });

  it('ignores a panel losing activation', () => {
    // onDidChangeViewState fires on deactivation too; only becoming active is a
    // user landing on the dashboard.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onDashboardActivated(7, false);
    expect(rec.terminals).toEqual([]);
  });

  it('never re-enters while a reveal is in flight', () => {
    // Both reveals preserve focus, so neither should raise the other's event —
    // but a host that behaves otherwise must not put the two listeners into an
    // unbounded ping-pong. The guard bounds it at one hop.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder({
      ...rec.deps,
      revealDashboard: (id) => {
        rec.dashboards.push(id);
        binder.onDashboardActivated(id, true);
      },
    });
    binder.onTerminalActivated(7);
    expect(rec.dashboards).toEqual([7]);
    expect(rec.terminals).toEqual([]);
  });

  it('accepts a fresh activation once the previous reveal has finished', () => {
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);
    binder.onTerminalActivated(7);
    binder.onTerminalActivated(8);
    expect(rec.dashboards).toEqual([7, 8]);
  });
});
