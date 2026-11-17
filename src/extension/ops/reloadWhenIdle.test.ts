import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createDrain } from '../../runtime/drain.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openShipRun } from '../../store/shipRuns.js';
import { countLiveRuns, guardShipStart, reloadWhenIdle, ShipDrainingError, type ReloadWhenIdleDeps } from './reloadWhenIdle.js';

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

  it('counts one auto-deliver once: its tracked entry and its open deliver_runs row are one run', () => {
    const store = openStore(':memory:');
    const t = createTicketFlow(store, { key: 'K-3', title: 't' });
    store.db
      .prepare("INSERT INTO deliver_runs (ticket_id, head_sha, gates, state, pid, started_at, kind) VALUES (?, 'h', '[]', 'running', 111, 'x', 'base-moved')")
      .run(t.id);
    // Drain.track counts the auto-deliver (extra = 1); the host passes its ticket, so the row is skipped.
    expect(countLiveRuns(store, 111, 1, [t.id])).toBe(1);
    // A row of another ticket still counts.
    expect(countLiveRuns(store, 111, 1, [t.id + 99])).toBe(2);
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

describe('guardShipStart', () => {
  it('lets a start run when not draining', () => {
    const log = vi.fn();
    expect(() => guardShipStart(createDrain(), 5, log)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it('throws, logs the reason draining and holds the ticket while draining', () => {
    const drain = createDrain();
    const log = vi.fn();
    drain.begin();
    expect(() => guardShipStart(drain, 5, log)).toThrow(ShipDrainingError);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('draining'));
    expect(drain.cancel()).toEqual([5]);
  });

  it('opens no ship run when the guard refuses the start', () => {
    const store = openStore(':memory:');
    const t = createTicketFlow(store, { key: 'K-4', title: 't' });
    const drain = createDrain();
    drain.begin();
    const start = (): void => {
      guardShipStart(drain, t.id, () => {});
      openShipRun(store, { ticketId: t.id, attempt: 1, startedAt: 'x', pid: 111 });
    };
    expect(start).toThrow(ShipDrainingError);
    expect(countLiveRuns(store, 111)).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM ship_runs').get()).toEqual({ n: 0 });
    expect(drain.cancel()).toEqual([t.id]);
    store.close();
  });

  it('does not refuse a start inside a tracked live run', async () => {
    const drain = createDrain();
    drain.begin();
    await drain.track(async () => {
      expect(() => guardShipStart(drain, 5, () => {})).not.toThrow();
    });
  });
});
