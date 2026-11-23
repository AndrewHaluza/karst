import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSleepLedger,
  defaultSleepLedger,
  startSleepLedger,
  SLEEP_EVENT_MIN_SLEPT_MS,
  SLEEP_EVENT_SETTLE_MS,
  SLEEP_GAP_MS,
  SLEEP_TICK_MS,
  sleepEventMessage,
  type SleepEvent,
} from './sleepLedger.js';

const T0 = Date.parse('2026-11-23T05:57:56.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function rig(opts: { gapMs?: number; maxEntries?: number } = {}) {
  const clock = { ms: T0 };
  const events: SleepEvent[] = [];
  const ledger = createSleepLedger({
    now: () => clock.ms,
    ...opts,
    report: (event) => events.push(event),
  });
  const tick = (): void => ledger.tick();
  return {
    clock,
    events,
    ledger,
    advance: (ms: number): void => {
      clock.ms += ms;
    },
    tick,
    /** Pass `ms` of awake time in ticks short enough to never read as a sleep. */
    awakeFor: (ms: number): void => {
      for (let left = ms; left > 0; left -= 30_000) {
        clock.ms += Math.min(30_000, left);
        tick();
      }
    },
  };
}

describe('createSleepLedger', () => {
  afterEach(() => vi.useRealTimers());

  it('counts wall time when the host never slept', () => {
    const r = rig();
    r.tick();
    r.advance(30_000);
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(30_000);
    expect(r.ledger.awakeWindowMs(2 * MIN, r.clock.ms)).toBe(2 * MIN);
    expect(r.events).toEqual([]);
  });

  it('records a gap only when it is longer than gapMs', () => {
    const r = rig({ gapMs: 45_000 });
    r.tick();
    r.advance(SLEEP_GAP_MS);
    r.tick();
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(SLEEP_GAP_MS);
  });

  it('subtracts a closed gap from the awake elapsed time', () => {
    const r = rig();
    r.tick();
    r.advance(5 * MIN);
    r.tick();
    r.advance(30_000);
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(30_000);
  });

  it('subtracts an OPEN gap on each read, before the tick timer fires', () => {
    const r = rig();
    r.tick();
    r.advance(5 * MIN);
    // No tick: the sweep timer runs before the ledger's own interval at wake.
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(0);
  });

  it('does not subtract a gap that ended before `since`', () => {
    const r = rig();
    r.tick();
    r.advance(5 * MIN);
    r.tick();
    r.awakeFor(4 * MIN);
    expect(r.ledger.awakeElapsedMs(T0 + 5 * MIN + 1_000, r.clock.ms)).toBe(4 * MIN - 1_000);
  });

  it('counts only the overlap of a gap that straddles `since`', () => {
    const r = rig();
    r.tick();
    r.advance(5 * MIN);
    r.tick();
    r.awakeFor(5 * MIN);
    // since = T0 + 2 min: 8 min wall, 3 min of it asleep.
    expect(r.ledger.awakeElapsedMs(T0 + 2 * MIN, r.clock.ms)).toBe(5 * MIN);
  });

  it('never reports below zero when the recorded sleeps cover the whole span', () => {
    const r = rig();
    r.tick();
    r.advance(5 * MIN);
    r.tick();
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(0);
  });

  it('records nothing on a backward clock step', () => {
    const r = rig();
    r.tick();
    r.advance(-10 * MIN);
    r.tick();
    expect(r.ledger.awakeElapsedMs(T0 - 10 * MIN, T0)).toBe(10 * MIN);
    // The clock comes back: no false gap is recorded for the step back.
    r.clock.ms = T0 + 30_000;
    r.tick();
    expect(r.ledger.awakeElapsedMs(T0 - 10 * MIN, r.clock.ms)).toBe(10 * MIN + 30_000);
  });

  it('drops the oldest entries past maxEntries', () => {
    const r = rig({ maxEntries: 2 });
    r.tick();
    for (let i = 0; i < 3; i++) {
      r.advance(5 * MIN);
      r.tick();
      r.advance(1_000);
      r.tick();
    }
    // 3 gaps of 5 min, only the last 2 survive.
    const wall = 15 * MIN + 3_000;
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(wall - 10 * MIN);
  });

  it('awakeWindowMs is the wall length that holds the window of awake time', () => {
    const r = rig();
    r.tick();
    r.advance(2 * HOUR); // the host slept
    r.tick();
    r.awakeFor(1 * MIN); // awake after the wake
    expect(r.ledger.awakeWindowMs(1 * MIN, r.clock.ms)).toBe(1 * MIN);
    // 1 min awake after the sleep + 1 min awake before it = 2 min, 2 h apart.
    expect(r.ledger.awakeWindowMs(2 * MIN, r.clock.ms)).toBe(2 * HOUR + 2 * MIN);
  });

  it('awakeWindowMs counts an open gap like a read does', () => {
    const r = rig();
    r.tick();
    r.advance(2 * MIN - 30_000);
    // Wall 90 s, open sleep 90 s: no awake time has passed at all.
    expect(r.ledger.awakeElapsedMs(T0, r.clock.ms)).toBe(0);
    expect(r.ledger.awakeWindowMs(30_000, r.clock.ms)).toBe(2 * MIN);
  });
});

describe('sleep events', () => {
  it('records ONE event for a sleep that has four DarkWakes', () => {
    const r = rig();
    r.tick();
    for (let i = 0; i < 4; i++) {
      r.advance(15 * MIN); // a DarkWake sleep
      r.tick();
      r.awakeFor(30_000); // briefly awake between DarkWakes
    }
    expect(r.events).toEqual([]); // still inside the wake run
    r.awakeFor(SLEEP_EVENT_SETTLE_MS + 1_000);
    expect(r.events).toHaveLength(1);
    const event = r.events[0]!;
    expect(event.startMs).toBe(T0);
    expect(event.sleptMs).toBe(4 * 15 * MIN);
    // The run ends at the last DarkWake: the three short awake spans separate them.
    expect(event.endMs).toBe(T0 + 4 * 15 * MIN + 3 * 30_000);
    // A further tick never repeats it.
    r.awakeFor(1 * MIN);
    expect(r.events).toHaveLength(1);
  });

  it('records no event for a 1-minute gap', () => {
    const r = rig();
    r.tick();
    r.advance(1 * MIN);
    r.tick();
    r.awakeFor(SLEEP_EVENT_SETTLE_MS + 1_000);
    expect(r.events).toEqual([]);
    expect(SLEEP_EVENT_MIN_SLEPT_MS).toBe(5 * MIN);
  });

  it('reports a run of exactly the minimum sleep after exactly the settle window', () => {
    const r = rig();
    r.tick();
    r.advance(SLEEP_EVENT_MIN_SLEPT_MS);
    r.tick();
    r.awakeFor(SLEEP_EVENT_SETTLE_MS);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.sleptMs).toBe(SLEEP_EVENT_MIN_SLEPT_MS);
  });

  it('counts separate sleeps apart when the host was awake between them', () => {
    const r = rig();
    r.tick();
    r.advance(5 * MIN);
    r.tick();
    r.awakeFor(SLEEP_EVENT_SETTLE_MS + 1_000);
    expect(r.events).toHaveLength(1);
    r.advance(5 * MIN);
    r.tick();
    r.awakeFor(SLEEP_EVENT_SETTLE_MS + 1_000);
    expect(r.events).toHaveLength(2);
  });

  it('formats the start, the end and the slept minutes', () => {
    const message = sleepEventMessage({ startMs: T0, endMs: T0 + 12 * MIN, sleptMs: 12 * MIN });
    expect(message).toContain('12 min');
    expect(message).toContain('2026-11-23T05:57:56.000Z');
    expect(message).toContain('2026-11-23T06:09:56.000Z');
  });
});

describe('the default ledger', () => {
  afterEach(() => vi.useRealTimers());

  it('reads zero sleep before it is started', () => {
    const now = Date.now();
    expect(defaultSleepLedger.awakeElapsedMs(now - HOUR, now)).toBe(HOUR);
    expect(defaultSleepLedger.awakeWindowMs(5 * MIN, now)).toBe(5 * MIN);
  });

  it('reads zero sleep for a long time after load, until it is started', () => {
    const clock = { ms: 0 };
    const ledger = createSleepLedger({ now: () => clock.ms, started: false });
    clock.ms += HOUR;
    expect(ledger.awakeElapsedMs(0, clock.ms)).toBe(HOUR);
    ledger.tick();
    clock.ms += 10 * MIN;
    expect(ledger.awakeElapsedMs(0, clock.ms)).toBe(HOUR + 10 * MIN);
    ledger.start();
    clock.ms += 10 * MIN;
    expect(ledger.awakeElapsedMs(clock.ms - 10 * MIN, clock.ms)).toBe(0);
  });

  it('starts an unref interval and disposes', () => {
    const handle = { unref: vi.fn() };
    const set = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => handle) as unknown as typeof setInterval);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    try {
      const started = startSleepLedger();
      expect(set).toHaveBeenCalledWith(expect.any(Function), SLEEP_TICK_MS);
      expect(handle.unref).toHaveBeenCalled();
      started.dispose();
      expect(clear).toHaveBeenCalledWith(handle);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it('records one info event through the notify for a wake run', () => {
    const clock = { ms: Date.now() };
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock.ms);
    let tickFn: (() => void) | undefined;
    const set = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      tickFn = fn;
      return { unref: vi.fn() };
    }) as unknown as typeof setInterval);
    const record = vi.fn();
    const started = startSleepLedger({ record });
    try {
      // A 10-minute sleep: the clock jumps and the interval fires ONCE, at wake.
      clock.ms += 10 * MIN;
      tickFn!();
      for (let i = 0; i < SLEEP_EVENT_SETTLE_MS / 30_000; i++) {
        clock.ms += 30_000;
        tickFn!();
      }
      expect(record).toHaveBeenCalledExactlyOnceWith('info', expect.stringContaining('slept 10 min'));
    } finally {
      started.dispose();
      set.mockRestore();
      now.mockRestore();
    }
  });
});
