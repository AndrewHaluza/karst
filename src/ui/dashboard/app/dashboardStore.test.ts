import { describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { DashboardStore } from './dashboardStore.js';

const proc = (id: string, status = 'pass') => ({ id, kind: id, label: id, status });
const stateWith = (processes: unknown[], clock = '1s'): DashboardState =>
  ({ ticketId: 1, insideViews: { uat: { stageKey: 'uat', title: 'UAT', clock, processes, blurb: '' } } }) as unknown as DashboardState;
const progress = (event: Record<string, unknown>): HostMessage => ({ type: 'inside-progress', event: { ticketId: 1, stage: 'uat', ...event } }) as HostMessage;

describe('DashboardStore — inside overlays and clocks', () => {
  it('starts with no overlays', () => {
    expect(new DashboardStore(null).getSnapshot().liveOps).toEqual({});
  });

  it('records an inside-progress event and notifies', () => {
    const store = new DashboardStore(stateWith([]));
    const seen = vi.fn();
    store.subscribe(seen);
    store.receive(progress({ kind: 'active', processId: 'gates', live: { status: 'run', label: 'lint' } }));
    expect(store.getSnapshot().liveOps).toEqual({ uat: { active: { status: 'run', label: 'lint' }, processId: 'gates' } });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('retires a completed overlay when a snapshot holds its process, even a live repaint', () => {
    const store = new DashboardStore(stateWith([]));
    store.receive(progress({ kind: 'completed', process: proc('gates') }));
    expect(store.getSnapshot().liveOps.uat).toBeDefined();
    store.receive({ type: 'state', state: stateWith([]), live: true });
    expect(store.getSnapshot().liveOps.uat).toBeDefined();
    store.receive({ type: 'state', state: stateWith([proc('gates')]), live: true });
    expect(store.getSnapshot().liveOps).toEqual({});
  });

  it('keeps an active overlay while the snapshot row still runs', () => {
    const store = new DashboardStore(stateWith([proc('tester', 'run')]));
    store.receive(progress({ kind: 'active', processId: 'tester', live: { status: 'run' } }));
    store.receive({ type: 'state', state: stateWith([proc('tester', 'run')]) });
    expect(store.getSnapshot().liveOps.uat).toBeDefined();
    store.receive({ type: 'state', state: stateWith([proc('tester', 'fail')]) });
    expect(store.getSnapshot().liveOps).toEqual({});
  });

  it('merges a clocks repaint into the held snapshot, keeping every other fact', () => {
    const store = new DashboardStore(stateWith([proc('tester', 'run')], '1s'));
    const before = store.getSnapshot().state;
    store.receive({ type: 'clocks', clocks: { uat: { clock: '9s', processes: { tester: { duration: '9s' } } } } } as HostMessage);
    const uat = (store.getSnapshot().state!.insideViews as unknown as Record<string, { clock: string; processes: unknown[] }>).uat!;
    expect(uat.clock).toBe('9s');
    expect(uat.processes[0]).toMatchObject({ duration: '9s', status: 'run' });
    expect(store.getSnapshot().state).not.toBe(before);
    expect(before!.insideViews).toEqual(stateWith([proc('tester', 'run')], '1s').insideViews);
  });

  it('ignores a clocks repaint before the first snapshot', () => {
    const store = new DashboardStore(null);
    const seen = vi.fn();
    store.subscribe(seen);
    store.receive({ type: 'clocks', clocks: {} } as HostMessage);
    expect(store.getSnapshot().state).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });
});
