import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../messages.js';
import { PendingOps } from './pendingOps.js';

const settle = vi.fn();
let ops: PendingOps;

beforeEach(() => {
  vi.useFakeTimers();
  settle.mockReset();
  (globalThis as unknown as { karstSettle: typeof settle }).karstSettle = settle;
  ops = new PendingOps();
});
afterEach(() => {
  ops.dispose();
  vi.useRealTimers();
});

const push = (state: Record<string, unknown>, extra: Record<string, unknown> = {}): void =>
  ops.receive({ type: 'state', state, ...extra } as unknown as HostMessage);
const atShip = (status?: string) => ({ stageCurrent: 'ship', currentStage: status ? { stageKey: 'ship', status } : null, prs: [] });

describe('PendingOps — the in-flight ship request (header and rail share it)', () => {
  it('starts idle and goes in flight on begin, clearing the post-ship flash', () => {
    expect(ops.getSnapshot()).toMatchObject({ shipping: false, shipped: false });
    ops.beginShip('r1');
    expect(ops.getSnapshot().shipping).toBe(true);
  });

  it('holds across a push that still shows ship running, and settles nothing', () => {
    ops.beginShip('r1');
    push(atShip('running'));
    expect(ops.getSnapshot().shipping).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  it('settles a failed ship as a failure and releases', () => {
    ops.beginShip('r1');
    push(atShip('failed'));
    expect(settle).toHaveBeenCalledWith('r1', false);
    expect(ops.getSnapshot()).toMatchObject({ shipping: false, shipped: false });
  });

  it('settles success once the ticket has left ship, and flashes "shipped" for 2.4 s', () => {
    ops.beginShip('r1');
    push({ stageCurrent: 'done', currentStage: null, prs: [] });
    expect(settle).toHaveBeenCalledWith('r1', true);
    expect(ops.getSnapshot()).toMatchObject({ shipping: false, shipped: true });
    vi.advanceTimersByTime(2399);
    expect(ops.getSnapshot().shipped).toBe(true);
    vi.advanceTimersByTime(1);
    expect(ops.getSnapshot().shipped).toBe(false);
  });

  it('ignores passive pushes (live clocks, store news): they carry no answer about an action', () => {
    ops.beginShip('r1');
    push({ stageCurrent: 'done', currentStage: null, prs: [] }, { settlesActions: false });
    push({ stageCurrent: 'done', currentStage: null, prs: [] }, { live: true, settlesActions: false });
    expect(ops.getSnapshot().shipping).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  it('a new ship request ends the previous flash', () => {
    ops.beginShip('r1');
    push({ stageCurrent: 'done', currentStage: null, prs: [] });
    ops.beginShip('r2');
    expect(ops.getSnapshot()).toMatchObject({ shipping: true, shipped: false });
    vi.advanceTimersByTime(5000);
    expect(ops.getSnapshot().shipping).toBe(true);
  });

  it('does nothing for a push when no ship is in flight', () => {
    push(atShip('failed'));
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('PendingOps — merge requests, per repo (rail and PR panel share them)', () => {
  const prs = (...rows: Array<[string, string]>) => ({ stageCurrent: 'ship', currentStage: null, prs: rows.map(([repo, status]) => ({ repo, status })) });

  it('marks the repo in flight without touching the others', () => {
    ops.beginMerge('/a', 'r1');
    expect([...ops.getSnapshot().merging]).toEqual(['/a']);
    ops.beginMerge('/b', 'r2');
    expect([...ops.getSnapshot().merging].sort()).toEqual(['/a', '/b']);
  });

  it('settles every outstanding request on the next settling push: merged is success, anything else unknown, never a failure', () => {
    ops.beginMerge('/a', 'r1');
    ops.beginMerge('/b', 'r2');
    ops.beginMerge('/c', 'r3');
    push(prs(['/a', 'merged'], ['/b', 'open']));
    expect(settle.mock.calls).toEqual([
      ['r1', true, 'Merged.'],
      ['r2', null, undefined],
      ['r3', null, undefined],
    ]);
    expect(ops.getSnapshot().merging.size).toBe(0);
  });

  it('survives passive and non-state messages', () => {
    ops.beginMerge('/a', 'r1');
    push(prs(['/a', 'merged']), { settlesActions: false });
    ops.receive({ type: 'bind', enabled: true } as unknown as HostMessage);
    expect(ops.getSnapshot().merging.has('/a')).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  it('a second merge for the same repo replaces the id it will settle', () => {
    ops.beginMerge('/a', 'r1');
    ops.beginMerge('/a', 'r2');
    push(prs(['/a', 'open']));
    expect(settle.mock.calls).toEqual([['r2', null, undefined]]);
  });
});

describe('PendingOps — the store contract', () => {
  it('notifies subscribers on change only, and hands back the same snapshot object when nothing changed', () => {
    const listener = vi.fn();
    const off = ops.subscribe(listener);
    const first = ops.getSnapshot();
    push(atShip('running'));
    expect(listener).not.toHaveBeenCalled();
    expect(ops.getSnapshot()).toBe(first);
    ops.beginShip('r1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ops.getSnapshot()).not.toBe(first);
    off();
    ops.beginMerge('/a', 'r2');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the merging set identity across a push that settles nothing', () => {
    ops.beginMerge('/a', 'r1');
    const set = ops.getSnapshot().merging;
    push(atShip('running'), { settlesActions: false });
    expect(ops.getSnapshot().merging).toBe(set);
  });

  it('drops its flash timer on dispose', () => {
    ops.beginShip('r1');
    push({ stageCurrent: 'done', currentStage: null, prs: [] });
    const listener = vi.fn();
    ops.subscribe(listener);
    ops.dispose();
    vi.advanceTimersByTime(5000);
    expect(listener).not.toHaveBeenCalled();
  });
});
