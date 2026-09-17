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

function seedRunningServer(store: Store, pid: number | null): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind, log_path, container)
       VALUES (7, 'api', NULL, NULL, ?, 'running', 'service', '/l', NULL)`,
    )
    .run(pid);
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

  it('reports each retired row and refreshes once', async () => {
    const store = openStore(':memory:');
    const id = seedRunningServer(store, null);
    const { loop, info, refresh } = deps(store);

    await loop.sweepNow();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "karst: 'api' is no longer running (pid unknown) on ticket #7 \u2014 marked offline.",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      (store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string })
        .status,
    ).toBe('stopped');
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

  it('returns immediately when a sweep is already in flight', async () => {
    const prepare = vi.fn(() => ({ all: () => [] as unknown[] }));
    const store = { db: { prepare } } as unknown as Store;
    const { loop } = deps(store);

    const first = loop.sweepNow();
    const second = loop.sweepNow();
    await Promise.all([first, second]);

    expect(prepare).toHaveBeenCalledTimes(1);
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
