import { describe, it, expect } from 'vitest';
import { changedPaths, hasLiveWork, liveClocks, LIVE_TICK_MS, structureKey } from './liveTick.js';
import type { DashboardState } from './state.js';
import type { InsideStageKey, InsideStageView } from '../../model/inside/types.js';

const STAGES: InsideStageKey[] = ['scope', 'impl', 'uat', 'review', 'ship', 'done'];

function view(over: Partial<InsideStageView> = {}): InsideStageView {
  return {
    stageKey: 'impl',
    title: 'Implementation',
    dot: 'pending',
    clock: 'has not run yet',
    processes: [],
    blurb: 'blurb',
    ...over,
  } as InsideStageView;
}

function stateWith(over: Partial<Record<InsideStageKey, InsideStageView>>): DashboardState {
  const insideViews = Object.fromEntries(
    STAGES.map((key) => [key, over[key] ?? view({ stageKey: key })]),
  ) as Record<InsideStageKey, InsideStageView>;
  return { insideViews } as DashboardState;
}

describe('hasLiveWork', () => {
  it('is false for a snapshot where nothing is running', () => {
    expect(hasLiveWork(stateWith({}))).toBe(false);
  });

  it('is true while a stage reports a running live line', () => {
    const state = stateWith({ uat: view({ stageKey: 'uat', live: { status: 'run', label: 'test' } }) });
    expect(hasLiveWork(state)).toBe(true);
  });

  it('is true while any process row is running', () => {
    const state = stateWith({
      impl: view({
        processes: [{ id: 'session', kind: 'session', label: 'Session', status: 'run' }],
      }),
    });
    expect(hasLiveWork(state)).toBe(true);
  });

  it('is false while a stage merely waits on a human — a park is not live work', () => {
    const state = stateWith({
      ship: view({ stageKey: 'ship', live: { status: 'wait', label: 'Waiting to merge' } }),
    });
    expect(hasLiveWork(state)).toBe(false);
  });

  it('ticks at a one-second cadence', () => {
    expect(LIVE_TICK_MS).toBe(1000);
  });
});

describe('structureKey', () => {
  const running = (duration: string, time: string) =>
    stateWith({
      uat: view({
        stageKey: 'uat',
        clock: `12:00:00 · ${duration}`,
        live: { status: 'run', label: 'test', duration },
        processes: [
          { id: 'tester', kind: 'tester', label: 'Tester', status: 'run', duration, durationExact: `${duration}.0`, time },
        ],
      }),
    });

  it('is unchanged when only the clocks advanced', () => {
    expect(structureKey(running('3s', '12:00:00'))).toBe(structureKey(running('4s', '12:00:00')));
  });

  it('ignores a time-derived age at any depth (graph node rows)', () => {
    const a = { ...running('3s', 't'), graph: { nodes: [{ id: 'n', age: '1m ago' }] } } as unknown as DashboardState;
    const b = { ...running('3s', 't'), graph: { nodes: [{ id: 'n', age: '2m ago' }] } } as unknown as DashboardState;
    expect(structureKey(a)).toBe(structureKey(b));
  });

  it('changes when a row appears or a status moves', () => {
    const base = running('3s', 't');
    const added = stateWith({
      uat: view({
        stageKey: 'uat',
        processes: [
          ...base.insideViews.uat.processes,
          { id: 'review', kind: 'review', label: 'Review', status: 'run' },
        ],
      }),
    });
    const settled = stateWith({
      uat: view({ stageKey: 'uat', processes: [{ id: 'tester', kind: 'tester', label: 'Tester', status: 'pass' }] }),
    });
    expect(structureKey(added)).not.toBe(structureKey(base));
    expect(structureKey(settled)).not.toBe(structureKey(base));
  });
});

describe('liveClocks', () => {
  it('carries each stage clock, the live duration, and running rows only', () => {
    const state = stateWith({
      uat: view({
        stageKey: 'uat',
        clock: '12:00:00 · 4s',
        live: { status: 'run', duration: '4s' },
        processes: [
          { id: 'tester', kind: 'tester', label: 'Tester', status: 'run', duration: '4s', durationExact: '4.0s', time: '12:00:00' },
          { id: 'old', kind: 'tester', label: 'Old', status: 'pass', duration: '9s', time: '11:00:00' },
        ],
      }),
    });
    const clocks = liveClocks(state);
    expect(clocks.uat).toEqual({
      clock: '12:00:00 · 4s',
      live: '4s',
      processes: { tester: { duration: '4s', durationExact: '4.0s', time: '12:00:00' } },
    });
    expect(clocks.scope).toEqual({ clock: 'has not run yet', processes: {} });
  });
});

describe('changedPaths', () => {
  it('names the nested fields that differ, ignoring clocks', () => {
    const prev = { a: { b: 1, c: { d: 'x' } }, clock: '1s', e: [1] };
    const next = { a: { b: 2, c: { d: 'x' } }, clock: '2s', e: [1, 2] };
    expect(changedPaths(prev, next)).toEqual(['a.b', 'e']);
  });

  it('is empty for structurally equal snapshots', () => {
    expect(changedPaths({ a: { duration: '1s' } }, { a: { duration: '9s' } })).toEqual([]);
  });

  it('stops at a bounded depth and reports added or removed keys', () => {
    const prev = { a: { b: { c: { d: { e: 1 } } } } };
    const next = { a: { b: { c: { d: { e: 2 } } } }, f: true };
    expect(changedPaths(prev, next)).toEqual(['a.b.c', 'f']);
  });
});
