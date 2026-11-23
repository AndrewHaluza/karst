import { describe, it, expect, vi } from 'vitest';

import { openStore, type Store } from '../../store/db.js';
import { createLivenessLoop, LIVENESS_SWEEP_MS } from './livenessLoop.js';

interface TimerHandle {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function timerRecorder() {
  const timers: TimerHandle[] = [];
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    const handle: TimerHandle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    const found = timers.find((t) => t === handle);
    if (found) found.cleared = true;
  });
  return { timers, setTimer, clearTimer };
}

function deps(store: Store, overrides: Record<string, unknown> = {}) {
  const info = vi.fn();
  const debug = vi.fn();
  const logError = vi.fn();
  const refresh = vi.fn();
  const openPanelCount = vi.fn(() => 1);
  const { timers, setTimer, clearTimer } = timerRecorder();
  const loop = createLivenessLoop({
    store,
    openPanelCount,
    refresh,
    info,
    debug,
    logError,
    setTimer,
    clearTimer,
    ...overrides,
  });
  return { loop, info, debug, logError, refresh, openPanelCount, timers, setTimer, clearTimer };
}

function seedRunningServer(store: Store, pid: number | null, sandbox: string | null = null): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind, log_path, container, sandbox)
       VALUES (7, 'api', '127.0.0.1', 8000, ?, 'running', 'service', '/l', NULL, ?)`,
    )
    .run(pid, sandbox);
  return Number(info.lastInsertRowid);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createLivenessLoop', () => {
  it('does no store read and no refresh when no panel is open', async () => {
    const prepare = vi.fn();
    const store = { db: { prepare } } as unknown as Store;
    const { loop, refresh } = deps(store, { openPanelCount: () => 0 });

    await loop.sweepNow();

    expect(prepare).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports each crashed row and refreshes once', async () => {
    const store = openStore(':memory:');
    const id = seedRunningServer(store, null, 'sbx:box:8000');
    const { loop, info, refresh } = deps(store, { sweepOpts: { portOpen: async () => false } });

    await loop.sweepNow();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "karst: 'api' exited unexpectedly (pid unknown) on ticket T7 \u2014 marked failed.",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      (store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string })
        .status,
    ).toBe('failed');
  });

  it('runs when only the Resources panel is open', async () => {
    const store = openStore(':memory:');
    const id = seedRunningServer(store, null, 'sbx:box:8000');
    const { loop } = deps(store, {
      openPanelCount: () => 0,
      openResourcesCount: () => 1,
      sweepOpts: { portOpen: async () => false },
    });

    await loop.sweepNow();

    expect(
      (store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string })
        .status,
    ).toBe('failed');
  });

  it('runs when a panel and the Resources panel are both open', async () => {
    const store = openStore(':memory:');
    const id = seedRunningServer(store, null, 'sbx:box:8000');
    const { loop } = deps(store, {
      openPanelCount: () => 1,
      openResourcesCount: () => 1,
      sweepOpts: { portOpen: async () => false },
    });

    await loop.sweepNow();

    expect(
      (store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string })
        .status,
    ).toBe('failed');
  });

  it('runs a new sweep after the previous one settled', async () => {
    const store = openStore(':memory:');
    seedRunningServer(store, null, 'sbx:box:8000');
    const { loop, info } = deps(store, { sweepOpts: { portOpen: async () => false } });

    await loop.sweepNow();
    seedRunningServer(store, null, 'sbx:box:8001');
    await loop.sweepNow();

    expect(info).toHaveBeenCalledTimes(2);
  });

  it('runs with no panel open when the caller asks for it (the monitor reading)', async () => {
    const store = openStore(':memory:');
    const id = seedRunningServer(store, null, 'sbx:box:8000');
    const { loop } = deps(store, { openPanelCount: () => 0, sweepOpts: { portOpen: async () => false } });

    await loop.sweepNow({ always: true });

    expect(
      (store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string })
        .status,
    ).toBe('failed');
  });

  it('does not refresh when nothing is retired', async () => {
    const store = openStore(':memory:');
    seedRunningServer(store, process.pid);
    const { loop, info, refresh } = deps(store);

    await loop.sweepNow();

    expect(info).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a failed sweep through logError without rejecting', async () => {
    const store = {
      db: {
        prepare: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Store;
    const { loop, logError } = deps(store);

    await expect(loop.sweepNow()).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('karst: server liveness sweep failed', expect.any(Error));
  });

  it('runs concurrent calls once, and each caller waits for that one sweep', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const store = openStore(':memory:');
    seedRunningServer(store, null, 'sbx:box:8000');
    const portOpen = vi.fn(async () => {
      await gate;
      return true;
    });
    const { loop } = deps(store, { sweepOpts: { portOpen } });
    const order: string[] = [];

    const first = loop.sweepNow().then(() => order.push('first'));
    const second = loop.sweepNow().then(() => order.push('second'));
    await flush();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);

    expect(portOpen).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['first', 'second']);
  });

  it('arms one timer, ignores a second start, and does not re-arm after dispose', async () => {
    const store = openStore(':memory:');
    const { loop, timers, setTimer, clearTimer } = deps(store);

    loop.start();
    loop.start();

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(timers[0]!.ms).toBe(LIVENESS_SWEEP_MS);

    loop.dispose();
    expect(clearTimer).toHaveBeenCalledTimes(1);

    timers[0]!.fn();
    await flush();

    expect(setTimer).toHaveBeenCalledTimes(1);
  });

  it('does not arm a second timer when start() is called during an in-flight sweep', async () => {
    const store = openStore(':memory:');
    // No open panel, so the in-flight sweep resolves without touching the store.
    const { loop, timers, setTimer } = deps(store, { openPanelCount: () => 0 });

    loop.start();
    expect(setTimer).toHaveBeenCalledTimes(1);

    // Fire the armed timer; the callback clears `timer` and begins the sweep,
    // then a re-entrant start() arrives before that sweep settles.
    timers[0]!.fn();
    loop.start();
    await flush();

    // Exactly one re-arm after the sweep — never a second concurrent timer.
    expect(setTimer).toHaveBeenCalledTimes(2);
  });

  it('keeps the periodic loop alive when openPanelCount throws', async () => {
    const store = { db: { prepare: () => ({ all: () => [] }) } } as unknown as Store;
    const openPanelCount = vi.fn(() => {
      throw new Error('boom');
    });
    const { loop, logError, timers, setTimer } = deps(store, { openPanelCount });

    await expect(loop.sweepNow()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);

    loop.start();
    timers[0]!.fn();
    await flush();

    // A rejection would have skipped the re-arm; the loop must survive.
    expect(setTimer).toHaveBeenCalledTimes(2);
  });
});
