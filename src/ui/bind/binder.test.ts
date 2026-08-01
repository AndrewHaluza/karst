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
    revealTerminal: (id) => {
      rec.terminals.push(id);
      return true;
    },
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

  it('never ping-pongs when its own reveals echo back asynchronously', () => {
    // The real host answers a reveal on a LATER turn: `panel.reveal` makes the
    // webview the active editor of the active group, and `terminal.show` makes
    // the terminal the active one — each raising the very event that reveals
    // the other. With two bound tickets in flight the echoes cross-feed, and an
    // in-flight guard that only spans one synchronous call cannot see it: the
    // window then switches tabs forever. Every reveal here is answered exactly
    // as the host answers it; the binder must come to rest.
    const rec = recorder(true);
    const pendingTerminals: number[] = [];
    const pendingDashboards: number[] = [];
    const binder = new TerminalDashboardBinder({
      ...rec.deps,
      revealDashboard: (id) => {
        rec.dashboards.push(id);
        pendingDashboards.push(id);
      },
      revealTerminal: (id) => {
        rec.terminals.push(id);
        pendingTerminals.push(id);
        return true;
      },
    });

    // Session recovery reveals two terminals; the activation events land next.
    binder.onTerminalActivated(7);
    binder.onTerminalActivated(8);
    for (let turn = 0; turn < 20; turn++) {
      const dashboards = pendingDashboards.splice(0);
      const terminals = pendingTerminals.splice(0);
      if (dashboards.length === 0 && terminals.length === 0) break;
      for (const id of dashboards) binder.onDashboardActivated(id, true);
      for (const id of terminals) binder.onTerminalActivated(id);
    }

    expect(pendingDashboards).toEqual([]);
    expect(pendingTerminals).toEqual([]);
    expect(rec.dashboards).toEqual([7, 8]);
    expect(rec.terminals).toEqual([]);
  });

  it('still binds the surface the user actually lands on afterwards', () => {
    // Suppressing the echo must not suppress the click that follows it.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);

    binder.onTerminalActivated(7);
    binder.onDashboardActivated(7, true); // karst's own reveal, echoed back
    binder.onDashboardActivated(7, true); // the user clicking the panel

    expect(rec.dashboards).toEqual([7]);
    expect(rec.terminals).toEqual([7]);
  });

  it('expects no echo from a reveal that revealed nothing', () => {
    // `revealTerminal` is reveal-only: a ticket whose agent is not running has
    // no terminal to show, so the call is a no-op and no activation follows it.
    // Announcing one anyway would leave an expectation nothing can ever consume,
    // and it would swallow the user's next real visit to that terminal.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder({
      ...rec.deps,
      revealTerminal: (id) => {
        rec.terminals.push(id);
        return false;
      },
    });

    binder.onDashboardActivated(7, true);
    expect(rec.terminals).toEqual([7]);

    // The session is started later and the user lands on its terminal.
    binder.onTerminalActivated(7);
    expect(rec.dashboards).toEqual([7]);
  });

  it('drops an unanswered terminal expectation once another terminal is active', () => {
    // Only one terminal is active at a time, so an activation for a DIFFERENT
    // ticket proves the expected one never arrived and never will.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);

    binder.onDashboardActivated(7, true); // announces terminal 7
    binder.onTerminalActivated(8); // 7's activation can no longer arrive
    binder.onTerminalActivated(7); // a real visit, not the lost echo

    expect(rec.terminals).toEqual([7]);
    expect(rec.dashboards).toEqual([8, 7]);
  });

  it('reveals nothing while suspended, and binds again once released', () => {
    // Startup recovery reveals terminals the user never touched. Binding off
    // those would drag a dashboard open per recovered ticket before the window
    // has finished coming up.
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);

    binder.suspend();
    binder.onTerminalActivated(7);
    binder.onDashboardActivated(8, true);
    expect(rec.dashboards).toEqual([]);
    expect(rec.terminals).toEqual([]);

    binder.resume();
    binder.onTerminalActivated(7);
    expect(rec.dashboards).toEqual([7]);
  });

  it('stays suspended until every overlapping suspension is released', () => {
    const rec = recorder(true);
    const binder = new TerminalDashboardBinder(rec.deps);

    binder.suspend();
    binder.suspend();
    binder.resume();
    binder.onTerminalActivated(7);
    expect(rec.dashboards).toEqual([]);

    binder.resume();
    binder.onTerminalActivated(7);
    expect(rec.dashboards).toEqual([7]);
  });
});
