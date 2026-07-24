import { describe, expect, it, vi } from 'vitest';
import {
  classifyRestoredSession,
  planBackgroundSessionRecovery,
  recoverSession,
  resumeRestoredSession,
  sessionOwnershipAction,
  SessionRecoveryLifecycle,
  SerializedStateWriter,
  shouldApplySessionHookState,
} from './sessionRecovery.js';
import { SessionManager, type FakeTerminal } from './session.js';
import type { AgentAdapter } from '../agent/adapter.js';

describe('resumeRestoredSession', () => {
  it('reports a failure when opening resolves without a terminal', async () => {
    const lifecycle = new SessionRecoveryLifecycle(100);
    const result = await resumeRestoredSession(
      { isOpen: () => false },
      lifecycle,
      7,
      async () => undefined,
    );

    expect(result).toEqual({ kind: 'not-open' });
  });

  it('preserves a rejected open command as a recovery failure', async () => {
    const error = new Error('no worktree');
    const lifecycle = new SessionRecoveryLifecycle(100);
    const result = await resumeRestoredSession(
      { isOpen: () => false },
      lifecycle,
      7,
      async () => Promise.reject(error),
    );

    expect(result).toEqual({ kind: 'rejected', error });
  });

  it('waits for SessionStart instead of treating a terminal map entry as ready', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new SessionRecoveryLifecycle(100);
      const result = resumeRestoredSession(
        { isOpen: () => true },
        lifecycle,
        7,
        async () => undefined,
      );

      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);

      lifecycle.sessionStarted(7, lifecycle.currentLaunchId(7));
      await expect(result).resolves.toEqual({ kind: 'opened' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a terminal that never reports SessionStart', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new SessionRecoveryLifecycle(100);
      const result = resumeRestoredSession(
        { isOpen: () => true },
        lifecycle,
        7,
        async () => undefined,
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toEqual({ kind: 'timed-out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an early replacement terminal close before SessionStart', async () => {
    const lifecycle = new SessionRecoveryLifecycle(100);
    const result = resumeRestoredSession(
      { isOpen: () => true },
      lifecycle,
      7,
      async () => undefined,
    );

    lifecycle.sessionClosed(7, lifecycle.currentLaunchId(7));

    await expect(result).resolves.toEqual({ kind: 'closed' });
  });
});

describe('recovery candidate planning', () => {
  it('classifies an owned resumable fix ticket without a worktree as idle', () => {
    expect(
      classifyRestoredSession({
        canResume: true,
        hasWorktree: false,
      }),
    ).toBe('idle');
  });

  it('recovers only this window’s active hidden sessions and reports broken ownership idle', () => {
    const result = planBackgroundSessionRecovery(
      [
        { id: 1, agentState: 'running', canResume: true, hasWorktree: true },
        { id: 2, agentState: 'waiting', canResume: true, hasWorktree: true },
        { id: 3, agentState: 'running', canResume: true, hasWorktree: false },
        { id: 4, agentState: 'idle', canResume: true, hasWorktree: true },
        { id: 5, agentState: 'running', canResume: true, hasWorktree: true },
      ],
      [1, 2, 3, 4],
    );

    expect(result).toEqual({ resume: [1, 2], idle: [3], discard: [4] });
  });

  it('prunes stale idle ownership before another window can make the ticket active', () => {
    const stale = planBackgroundSessionRecovery(
      [{ id: 7, agentState: 'idle', canResume: true, hasWorktree: true }],
      [7],
    );
    expect(stale.discard).toEqual([7]);

    const afterOtherWindowStarts = planBackgroundSessionRecovery(
      [{ id: 7, agentState: 'running', canResume: true, hasWorktree: true }],
      stale.resume,
    );
    expect(afterOtherWindowStarts.resume).toEqual([]);
  });

  it('drops local ownership as soon as the local session reports Stop', () => {
    expect(sessionOwnershipAction('Stop', true)).toBe('remove');
    expect(sessionOwnershipAction('SessionEnd', false)).toBe('remove');
    expect(sessionOwnershipAction('SessionStart', true)).toBe('add');
  });
});

describe('recovery lifecycle ordering', () => {
  it('rejects a late SessionEnd while the replacement terminal is live', () => {
    expect(
      shouldApplySessionHookState(
        { isOpen: () => true },
        new SessionRecoveryLifecycle(),
        7,
        { hook_event_name: 'SessionEnd' },
      ),
    ).toBe(false);
  });

  it('allows SessionEnd after the replacement terminal has closed', () => {
    expect(
      shouldApplySessionHookState(
        { isOpen: () => false },
        new SessionRecoveryLifecycle(),
        7,
        { hook_event_name: 'SessionEnd' },
      ),
    ).toBe(true);
  });

  it('quarantines a late SessionStart after timeout until delayed terminal close', async () => {
    vi.useFakeTimers();
    try {
      let open = false;
      let disposed = false;
      const sessions = {
        isOpen: () => open,
        disposeSession: () => {
          open = false;
          disposed = true;
        },
      };
      const lifecycle = new SessionRecoveryLifecycle(100);
      const recovery = recoverSession(
        sessions,
        lifecycle,
        7,
        async () => {
          open = true;
        },
      );
      const failedLaunch = lifecycle.currentLaunchId(7);

      await vi.advanceTimersByTimeAsync(100);
      await expect(recovery).resolves.toEqual({ kind: 'timed-out' });
      expect(disposed).toBe(true);
      expect(
        shouldApplySessionHookState(
          sessions,
          lifecycle,
          7,
          { hook_event_name: 'SessionStart', launchId: failedLaunch },
        ),
      ).toBe(false);

      lifecycle.sessionStarted(7, failedLaunch);
      expect(
        shouldApplySessionHookState(
          sessions,
          lifecycle,
          7,
          { hook_event_name: 'SessionStart', launchId: failedLaunch },
        ),
      ).toBe(false);

      lifecycle.sessionClosed(7, failedLaunch);
      expect(
        shouldApplySessionHookState(
          sessions,
          lifecycle,
          7,
          { hook_event_name: 'SessionStart', launchId: failedLaunch },
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a failed outcome when retirement cleanup throws so fallback still runs', async () => {
    vi.useFakeTimers();
    try {
      const cleanupError = new Error('cleanup failed');
      const cleanup = vi.fn(() => {
        throw cleanupError;
      });
      let close = (): void => {};
      const terminal: FakeTerminal = {
        name: 'Karst: #7',
        cwd: '/wt/a',
        shellPath: 'agent',
        shellArgs: [],
        env: {},
        shown: 0,
        sent: [],
        disposed: false,
        show: () => {},
        sendText: () => {},
        dispose: () => {
          terminal.disposed = true;
        },
        onDidClose: (handler) => {
          close = handler;
        },
      };
      const adapter: AgentAdapter = {
        buildInteractiveCommand: () => ({
          command: 'agent',
          args: [],
          env: {},
        }),
        runHeadless: () => Promise.reject(new Error('not used')),
        requiredBinary: 'agent',
        capabilities: { lifecycleEvents: true, resume: true },
      };
      const sessions = new SessionManager(
        { createTerminal: () => terminal },
        () => ({ endpointUrl: 'http://127.0.0.1:1/hooks', configDir: '/tmp' }),
        undefined,
        cleanup,
      );
      const lifecycle = new SessionRecoveryLifecycle(10);
      let agentState = 'running';
      const owned = new Set([7]);
      let refreshes = 0;

      const recovery = recoverSession(sessions, lifecycle, 7, async () => {
        sessions.openSession(adapter, 7, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
          '/wt/a/.codex/karst/recovery',
        ]);
      }).then((outcome) => {
        if (outcome.kind !== 'opened') {
          agentState = 'idle';
          owned.delete(7);
          refreshes++;
        }
        return outcome;
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(recovery).resolves.toEqual({
        kind: 'rejected',
        error: cleanupError,
      });
      expect(terminal.disposed).toBe(true);
      expect(agentState).toBe('idle');
      expect(owned.has(7)).toBe(false);
      expect(refreshes).toBe(1);
      expect(cleanup).toHaveBeenCalledTimes(1);

      close();
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coordinates three hook-ready replacement cycles with one nudge each', async () => {
    let open = false;
    const nudges: string[] = [];
    const sessions = {
      isOpen: () => open,
      disposeSession: () => {
        open = false;
      },
    };
    const lifecycle = new SessionRecoveryLifecycle(100);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const recovery = recoverSession(
        sessions,
        lifecycle,
        7,
        async () => {
          open = true;
        },
      );
      const launchId = lifecycle.currentLaunchId(7);
      lifecycle.sessionStarted(7, launchId);
      await expect(recovery).resolves.toEqual({ kind: 'opened' });
      nudges.push(`responsive-${cycle}`);

      open = false;
      lifecycle.sessionClosed(7, launchId);
    }

    expect(nudges).toEqual(['responsive-1', 'responsive-2', 'responsive-3']);
  });

  it('accepts a retry SessionStart before the old terminal’s delayed close', async () => {
    vi.useFakeTimers();
    try {
      let open = false;
      const sessions = {
        isOpen: () => open,
        disposeSession: () => {
          open = false;
        },
      };
      const lifecycle = new SessionRecoveryLifecycle(10);
      const first = recoverSession(sessions, lifecycle, 7, async () => {
        open = true;
      });
      const oldLaunch = lifecycle.currentLaunchId(7)!;
      await vi.advanceTimersByTimeAsync(10);
      await expect(first).resolves.toEqual({ kind: 'timed-out' });

      const retry = recoverSession(sessions, lifecycle, 7, async () => {
        open = true;
      });
      const retryLaunch = lifecycle.currentLaunchId(7)!;
      expect(retryLaunch).not.toBe(oldLaunch);
      expect(
        shouldApplySessionHookState(sessions, lifecycle, 7, {
          hook_event_name: 'SessionStart',
          launchId: oldLaunch,
        }),
      ).toBe(false);

      lifecycle.sessionStarted(7, retryLaunch);
      lifecycle.sessionClosed(7, oldLaunch);
      await expect(retry).resolves.toEqual({ kind: 'opened' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a stale SessionStart even after the old terminal closes', async () => {
    vi.useFakeTimers();
    try {
      let open = false;
      const sessions = {
        isOpen: () => open,
        disposeSession: () => {
          open = false;
        },
      };
      const lifecycle = new SessionRecoveryLifecycle(10);
      const recovery = recoverSession(sessions, lifecycle, 7, async () => {
        open = true;
      });
      const failedLaunch = lifecycle.currentLaunchId(7)!;
      await vi.advanceTimersByTimeAsync(10);
      await recovery;
      lifecycle.sessionClosed(7, failedLaunch);

      expect(
        shouldApplySessionHookState(sessions, lifecycle, 7, {
          hook_event_name: 'SessionStart',
          launchId: failedLaunch,
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds retired launch generations deterministically', () => {
    const lifecycle = new SessionRecoveryLifecycle(100, 2);
    const launches = [1, 2, 3].map(() => {
      const launchId = lifecycle.startLaunch(7);
      lifecycle.sessionClosed(7, launchId);
      return launchId;
    });

    expect(lifecycle.isCurrentHook(7, launches[0])).toBe(true);
    expect(lifecycle.isCurrentHook(7, launches[1])).toBe(false);
    expect(lifecycle.isCurrentHook(7, launches[2])).toBe(false);
  });

  it('shutdown resolves a pending recovery and clears its timeout', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new SessionRecoveryLifecycle(100);
      const recovery = resumeRestoredSession(
        { isOpen: () => true },
        lifecycle,
        7,
        async () => undefined,
      );

      lifecycle.shutdown();

      await expect(recovery).resolves.toEqual({ kind: 'interrupted' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SerializedStateWriter', () => {
  it('serializes snapshots and flush waits for the final write', async () => {
    const writes: number[] = [];
    const releases: Array<() => void> = [];
    const writer = new SerializedStateWriter<number>(async (value) => {
      writes.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = writer.enqueue(1);
    const second = writer.enqueue(2);
    await Promise.resolve();
    expect(writes).toEqual([1]);

    releases.shift()!();
    await first;
    await Promise.resolve();
    expect(writes).toEqual([1, 2]);

    releases.shift()!();
    await second;
    await writer.flush();
    expect(writes).toEqual([1, 2]);
  });
});
