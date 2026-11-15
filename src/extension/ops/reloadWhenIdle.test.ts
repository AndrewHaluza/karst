import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createDrain } from '../../runtime/drain.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openShipRun } from '../../store/shipRuns.js';
import { countLiveRuns, refuseShipWhileDraining, reloadWhenIdle, type ReloadWhenIdleDeps } from './reloadWhenIdle.js';

function deps(counts: number[], over: Partial<ReloadWhenIdleDeps> = {}) {
  const drain = createDrain();
  const reload = vi.fn(async () => {});
  const seen: number[] = [];
  const d: { -readonly [K in keyof ReloadWhenIdleDeps]: ReloadWhenIdleDeps[K] } = {
    drain,
    countLive: () => counts.length > 1 ? counts.shift()! : counts[0]!,
    reload,
    onCount: (n) => seen.push(n),
    sleep: async () => {},
    signal: new AbortController().signal,
    log: () => {},
    ...over,
  };
  return { d, drain, reload, seen };
}

describe('reloadWhenIdle', () => {
  it('holds new starts, reports each count and reloads only at zero', async () => {
    const { d, drain, reload, seen } = deps([2, 2, 1, 0]);
    const sleepSawDrain: boolean[] = [];
    d.sleep = async () => {
      sleepSawDrain.push(drain.isDraining());
      expect(reload).not.toHaveBeenCalled();
    };
    expect(await reloadWhenIdle(d)).toBe('reloaded');
    expect(seen).toEqual([2, 1, 0]);
    expect(sleepSawDrain.every(Boolean)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('clears the drain flag and does not reload when cancelled', async () => {
    const ac = new AbortController();
    const { d, drain, reload } = deps([3], { signal: ac.signal });
    d.sleep = async () => ac.abort();
    expect(await reloadWhenIdle(d)).toBe('cancelled');
    expect(drain.isDraining()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('hands the held tickets to onCancelled after a cancel', async () => {
    const ac = new AbortController();
    const onCancelled = vi.fn();
    const { d, drain } = deps([3], { signal: ac.signal, onCancelled });
    d.sleep = async () => {
      drain.hold(7);
      ac.abort();
    };
    await reloadWhenIdle(d);
    expect(onCancelled).toHaveBeenCalledWith([7]);
  });

  it('clears the drain flag and hands over held tickets when the reload fails', async () => {
    const onCancelled = vi.fn();
    const { d, drain } = deps([0], {
      onCancelled,
      reload: async () => {
        throw new Error('boom');
      },
    });
    await expect(reloadWhenIdle(d)).rejects.toThrow('boom');
    expect(drain.isDraining()).toBe(false);
    expect(onCancelled).toHaveBeenCalledWith([]);
  });
});

describe('countLiveRuns', () => {
  it('counts running rows of this host pid only', () => {
    const store = openStore(':memory:');
    expect(countLiveRuns(store, 111)).toBe(0);
    const t = createTicketFlow(store, { key: 'K-1', title: 't' });
    store.db
      .prepare(
        `INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, pid, started_at)
         VALUES (?, 'uat', 1, 'x', 'running', 111, 'x'), (?, 'review', 1, 'x', 'running', 222, 'x'),
                (?, 'uat', 2, 'x', 'finished', 111, 'x')`,
      )
      .run(t.id, t.id, t.id);
    expect(countLiveRuns(store, 111)).toBe(1);
    expect(countLiveRuns(store, 111, 2)).toBe(3);
    store.close();
  });

  it('counts a running deliver run of this host pid (an auto-deliver runs outside any stage run)', () => {
    const store = openStore(':memory:');
    const t = createTicketFlow(store, { key: 'K-2', title: 't' });
    store.db
      .prepare(
        `INSERT INTO deliver_runs (ticket_id, head_sha, gates, state, pid, started_at, kind)
         VALUES (?, 'h', '[]', 'running', 111, 'x', 'auto'), (?, 'h', '[]', 'running', 222, 'x', 'auto'),
                (?, 'h', '[]', 'stopped', 111, 'x', 'auto')`,
      )
      .run(t.id, t.id, t.id);
    expect(countLiveRuns(store, 111)).toBe(1);
    store.close();
  });
});

describe('countLiveRuns ship runs', () => {
  it('counts a running ship run of this host pid only (the ship saga writes no stage run)', () => {
    const store = openStore(':memory:');
    const t = createTicketFlow(store, { key: 'K-3', title: 't' });
    openShipRun(store, { ticketId: t.id, attempt: 1, startedAt: 'x', pid: 111 });
    expect(countLiveRuns(store, 111)).toBe(1);
    expect(countLiveRuns(store, 222)).toBe(0);
    store.close();
  });
});

describe('refuseShipWhileDraining', () => {
  it('starts when not draining', () => {
    const drain = createDrain();
    const log = vi.fn();
    expect(refuseShipWhileDraining(drain, 5, log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses, logs the reason draining and holds the ticket while draining', () => {
    const drain = createDrain();
    const log = vi.fn();
    drain.begin();
    expect(refuseShipWhileDraining(drain, 5, log)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('draining'));
    expect(drain.cancel()).toEqual([5]);
  });

  it('does not refuse a start inside a tracked live run', async () => {
    const drain = createDrain();
    drain.begin();
    await drain.track(async () => {
      expect(refuseShipWhileDraining(drain, 5, () => {})).toBe(false);
    });
  });
});
