import { describe, it, expect } from 'vitest';
import { hasLiveWork, LIVE_TICK_MS } from './liveTick.js';
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
