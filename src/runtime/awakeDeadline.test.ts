import { describe, expect, it, vi } from 'vitest';

import { AWAKE_CHUNK_MS, startAwakeDeadline } from './awakeDeadline.js';

/**
 * A hand-driven timer queue. vitest's fake timers fire every chained chunk in
 * one `advanceTimersByTime`, so they cannot model a host sleep (a chunk that
 * fires long after its nominal length). Here only the caller fires the pending
 * chunk, which is what a real wake does when the chain resumes.
 */
function handTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers = {
    set: (fn: () => void, ms: number) => {
      scheduled.push({ fn, ms, live: true });
      return scheduled.length - 1;
    },
    clear: (handle: unknown) => {
      const entry = scheduled[handle as number];
      if (entry) entry.live = false;
    },
  };
  const live = () => scheduled.filter((t) => t.live);
  /** Fire exactly the one chunk the chain is waiting on. */
  const firePending = () => {
    const pending = live();
    expect(pending).toHaveLength(1);
    const entry = pending[0]!;
    entry.live = false;
    entry.fn();
  };
  const lengths = () => scheduled.map((t) => t.ms);
  return { timers, scheduled, live, firePending, lengths };
}

describe('startAwakeDeadline', () => {
  it('expires on chunk 60 of a 60 s deadline, not on chunk 59', () => {
    const h = handTimers();
    const onExpire = vi.fn();
    startAwakeDeadline(60_000, onExpire, h.timers);

    for (let i = 0; i < 59; i++) {
      expect(onExpire).not.toHaveBeenCalled();
      h.firePending();
    }
    expect(onExpire).not.toHaveBeenCalled();

    h.firePending();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('credits only the nominal chunk length, whatever time passes between chunks', () => {
    const h = handTimers();
    const onExpire = vi.fn();
    startAwakeDeadline(3_000, onExpire, h.timers);

    // A sleep of any length is invisible: the chain only knows how many chunks
    // fired, so two chunks never expire a three-chunk deadline.
    h.firePending();
    h.firePending();
    expect(onExpire).not.toHaveBeenCalled();
    h.firePending();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never expires after cancel, and cancel is idempotent and stops the chain', () => {
    const h = handTimers();
    const onExpire = vi.fn();
    const deadline = startAwakeDeadline(10_000, onExpire, h.timers);

    h.firePending();
    deadline.cancel();
    deadline.cancel();

    expect(h.live()).toHaveLength(0);
    expect(onExpire).not.toHaveBeenCalled();
    // Nothing is left to fire, so a late wake cannot resurrect the chain.
    expect(h.live()).toHaveLength(0);
  });

  it('expires on the first firing when ms is zero or negative', () => {
    for (const ms of [0, -5]) {
      const h = handTimers();
      const onExpire = vi.fn();
      startAwakeDeadline(ms, onExpire, h.timers);

      expect(h.lengths()).toEqual([0]);
      h.firePending();
      expect(onExpire).toHaveBeenCalledTimes(1);
    }
  });

  it('schedules a short last chunk with its own length', () => {
    const h = handTimers();
    startAwakeDeadline(2_500, () => {}, h.timers);

    h.firePending();
    h.firePending();
    h.firePending();

    expect(h.lengths()).toEqual([AWAKE_CHUNK_MS, AWAKE_CHUNK_MS, 500]);
  });

  it('runs onExpire at most once', () => {
    const h = handTimers();
    const onExpire = vi.fn();
    startAwakeDeadline(1_000, onExpire, h.timers);

    h.firePending();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(h.live()).toHaveLength(0);
  });

  it('defaults the chunk size to 1000 ms', () => {
    expect(AWAKE_CHUNK_MS).toBe(1000);
  });
});
