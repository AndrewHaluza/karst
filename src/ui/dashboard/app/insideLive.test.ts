import { describe, expect, it } from 'vitest';
import type { InsideProcessView, InsideStageView } from '../../../model/inside/types.js';
import type { DashboardState } from '../state.js';
import { applyClocks, liveOperation, overlayProcesses, receiveProgress, retireOverlays, sameIgnoringLive, type LiveOps } from './insideLive.js';

const proc = (id: string, over: Record<string, unknown> = {}): InsideProcessView => ({ id, kind: id, label: id, status: 'pass', ...over }) as unknown as InsideProcessView;
const view = (over: Record<string, unknown> = {}): InsideStageView =>
  ({ stageKey: 'uat', title: 'UAT', clock: '1s', processes: [proc('gates'), proc('tester', { status: 'run', time: 't0', duration: '1s' })], blurb: '', ...over }) as unknown as InsideStageView;
const stateOf = (v: unknown, stage = 'uat'): DashboardState => ({ insideViews: { [stage]: v } }) as unknown as DashboardState;
const viewsOf = (state: DashboardState): Record<string, InsideStageView> => state.insideViews as unknown as Record<string, InsideStageView>;

describe('overlayProcesses', () => {
  it('is the snapshot rows when no overlay completes one', () => {
    const v = view();
    expect(overlayProcesses(v, {})).toBe(v.processes);
    expect(overlayProcesses(v, { uat: { active: { status: 'run' }, processId: 'gates' } })).toBe(v.processes);
  });

  it('appends a completed row the snapshot does not know', () => {
    const extra = proc('extra');
    expect(overlayProcesses(view(), { uat: { completed: extra } }).map((p) => p.id)).toEqual(['gates', 'tester', 'extra']);
  });

  it('merges a completed row over the same id but keeps the evidence the event does not carry', () => {
    const ev = { kind: 'rows', rows: [] };
    const v = view({ processes: [proc('gates', { evidence: ev, detail: 'old' })] });
    const rows = overlayProcesses(v, { uat: { completed: proc('gates', { detail: 'new', status: 'fail' }) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ detail: 'new', status: 'fail', evidence: ev });
  });

  it('lets the event bring its own evidence', () => {
    const own = { kind: 'rows', rows: [{ label: 'x' }] };
    const v = view({ processes: [proc('gates', { evidence: { kind: 'rows', rows: [] } })] });
    expect(overlayProcesses(v, { uat: { completed: proc('gates', { evidence: own }) } })[0]).toMatchObject({ evidence: own });
  });
});

describe('liveOperation', () => {
  it('prefers the progress event over the snapshot line, and has none otherwise', () => {
    const active = { status: 'run', label: 'lint' } as never;
    const own = { status: 'wait', label: 'snap' } as never;
    expect(liveOperation(view({ live: own }), { uat: { active, processId: 'gates' } })).toBe(active);
    expect(liveOperation(view({ live: own }), {})).toBe(own);
    expect(liveOperation(view(), {})).toBeNull();
  });
});

describe('receiveProgress', () => {
  const ev = { ticketId: 1, stage: 'uat' } as const;
  it('records an active operation, a completed row and clears one, without touching other stages', () => {
    const live = { status: 'run' } as never;
    let ops: LiveOps = receiveProgress({}, { ...ev, kind: 'active', processId: 'gates', live });
    expect(ops).toEqual({ uat: { active: live, processId: 'gates' } });
    const row = proc('gates');
    ops = receiveProgress({ ...ops, ship: { processId: 'x' } }, { ...ev, kind: 'completed', process: row });
    expect(ops).toEqual({ uat: { completed: row }, ship: { processId: 'x' } });
    expect(receiveProgress(ops, { ...ev, kind: 'cleared', processId: 'gates' })).toEqual({ ship: { processId: 'x' } });
  });

  it('keeps identity when clearing a stage that has no overlay', () => {
    const ops: LiveOps = {};
    expect(receiveProgress(ops, { ...ev, kind: 'cleared', processId: 'gates' })).toBe(ops);
  });
});

describe('retireOverlays', () => {
  it('retires a completed overlay once the snapshot holds its process, whatever its status', () => {
    const ops: LiveOps = { uat: { completed: proc('tester') } };
    expect(retireOverlays(ops, stateOf(view()))).toEqual({});
  });

  it('retires an active overlay only on a terminal row, and keeps it while the row still runs', () => {
    const ops: LiveOps = { uat: { active: { status: 'run' } as never, processId: 'tester' } };
    expect(retireOverlays(ops, stateOf(view()))).toBe(ops);
    expect(retireOverlays(ops, stateOf(view({ processes: [proc('tester', { status: 'fail' })] })))).toEqual({});
  });

  it('keeps an overlay the snapshot does not know, and an active one without a process id', () => {
    const ops: LiveOps = { uat: { active: { status: 'run' } as never, processId: 'ghost' }, ship: { active: { status: 'run' } as never } };
    expect(retireOverlays(ops, stateOf(view()))).toBe(ops);
  });
});

describe('applyClocks', () => {
  const clocks = { uat: { clock: '9s', live: '4s', processes: { tester: { time: 't1', duration: '9s', durationExact: '9.1s' } } } };

  it('writes the clock text into the stage, its live line and its running rows only', () => {
    const v = view({ live: { status: 'run', label: 'l', duration: '1s' } });
    const next = applyClocks(stateOf(v), clocks as never);
    const nv = viewsOf(next).uat!;
    expect(nv.clock).toBe('9s');
    expect(nv.live?.duration).toBe('4s');
    expect(nv.processes[0]).toBe(v.processes[0]);
    expect(nv.processes[1]).toMatchObject({ time: 't1', duration: '9s', durationExact: '9.1s', status: 'run' });
  });

  it('leaves a view without a live line, and stages the clocks do not name, alone', () => {
    const state = stateOf(view());
    const next = applyClocks(state, { review: { clock: 'x', processes: {} } } as never);
    expect(next.insideViews).toEqual(state.insideViews);
    const noLive = applyClocks(state, { uat: { clock: '2s', live: '3s', processes: {} } } as never);
    expect(viewsOf(noLive).uat!.live).toBeUndefined();
  });

  it('never mutates the held snapshot', () => {
    const state = stateOf(view());
    const before = JSON.stringify(state);
    applyClocks(state, clocks as never);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('sameIgnoringLive', () => {
  it('ignores the clock keys and tokens at any depth, and nothing else', () => {
    const a = { clock: '1s', processes: [{ id: 'a', time: 't', duration: '1s', tokens: { total: '1k' }, nested: { age: '1m', label: 'x' } }] };
    const b = { clock: '2s', processes: [{ id: 'a', time: 'u', duration: '2s', tokens: { total: '2k' }, nested: { age: '2m', label: 'x' } }] };
    expect(sameIgnoringLive(a, b)).toBe(true);
    expect(sameIgnoringLive(a, { ...b, processes: [{ ...b.processes[0]!, id: 'b' }] })).toBe(false);
    expect(sameIgnoringLive(a, { ...b, processes: [] })).toBe(false);
    expect(sameIgnoringLive([1], [1, 2])).toBe(false);
    expect(sameIgnoringLive(null, null)).toBe(true);
    expect(sameIgnoringLive(null, {})).toBe(false);
  });
});
