import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createDrain } from '../../runtime/drain.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { countLiveRuns, reloadWhenIdle, type ReloadWhenIdleDeps } from './reloadWhenIdle.js';

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

  it('clears the drain flag when the reload fails', async () => {
    const { d, drain } = deps([0], {
      reload: async () => {
        throw new Error('boom');
      },
    });
    await expect(reloadWhenIdle(d)).rejects.toThrow('boom');
    expect(drain.isDraining()).toBe(false);
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
    store.close();
  });
});
