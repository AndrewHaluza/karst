import { describe, expect, it, vi } from 'vitest';
import { StaleDiffTargetError, type DiffTarget } from './git.js';
import type { ChangesHostMessage } from './messages.js';
import { TicketChangesManager, type ChangesPanel, type ChangesPanelHost } from './panel.js';
import type { TicketChangesSnapshot, TicketChangesState } from './snapshot.js';

class FakePanel implements ChangesPanel {
  revealed = 0;
  posted: ChangesHostMessage[] = [];
  column: number | undefined = 1;
  private messageHandler?: (message: unknown) => void;
  private disposeHandler?: () => void;

  reveal(): void { this.revealed += 1; }
  viewColumn(): number | undefined { return this.column; }
  postMessage(message: ChangesHostMessage): void { this.posted.push(message); }
  onDidReceiveMessage(handler: (message: unknown) => void): void { this.messageHandler = handler; }
  onDidDispose(handler: () => void): void { this.disposeHandler = handler; }
  emit(message: unknown): void { this.messageHandler?.(message); }
  dispose(): void { this.disposeHandler?.(); }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function target(path: string): DiffTarget {
  return {
    repoLabel: 'Repository',
    groupLabel: 'Changes',
    displayPath: path,
    left: { kind: 'empty', label: 'Empty' },
    right: { kind: 'working', path: `/worktrees/repository/${path}`, label: 'Working Tree' },
  };
}

function snapshot(ticketId: number, changeId: string, diffTarget: DiffTarget): TicketChangesSnapshot {
  const state: TicketChangesState = {
    ticketId,
    worktreeCount: 1,
    commitCount: 0,
    pendingCount: 1,
    worktrees: [{
      label: 'Repository',
      branch: 'ticket/changes',
      baseRef: 'main',
      commits: [],
      staged: [{ changeId, status: 'modified', path: diffTarget.displayPath, oldPath: null }],
      unstaged: [],
      untracked: [],
      error: null,
    }],
  };
  return { state, targets: new Map([[changeId, diffTarget]]) };
}

function makeHost(): { host: ChangesPanelHost; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  return {
    host: {
      createPanel: () => {
        const panel = new FakePanel();
        panels.push(panel);
        return panel;
      },
    },
    panels,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('TicketChangesManager', () => {
  it('posts loading then state on first open', async () => {
    const load = deferred<TicketChangesSnapshot>();
    const { host, panels } = makeHost();
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, () => load.promise, async () => {}, () => {});

    manager.open(41);
    expect(panels[0]!.posted).toEqual([{ type: 'loading', state: null }]);

    const current = snapshot(41, 'first:1', target('src/first.ts'));
    load.resolve(current);
    await settle();

    expect(panels[0]!.posted).toEqual([
      { type: 'loading', state: null },
      { type: 'state', state: current.state },
    ]);
  });

  it('reveals and refreshes the existing panel instead of duplicating it', async () => {
    const first = deferred<TicketChangesSnapshot>();
    const second = deferred<TicketChangesSnapshot>();
    const load = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { host, panels } = makeHost();
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, load, async () => {}, () => {});

    manager.open(41);
    first.resolve(snapshot(41, 'first:1', target('src/first.ts')));
    await settle();
    manager.open(41);

    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBe(1);
    expect(panels[0]!.posted.at(-1)).toEqual({
      type: 'loading',
      state: snapshot(41, 'first:1', target('src/first.ts')).state,
    });
    second.resolve(snapshot(41, 'second:1', target('src/second.ts')));
    await settle();
  });

  it('retains the last successful state while refreshing', async () => {
    const first = deferred<TicketChangesSnapshot>();
    const second = deferred<TicketChangesSnapshot>();
    const load = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { host, panels } = makeHost();
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, load, async () => {}, () => {});
    const initial = snapshot(41, 'first:1', target('src/first.ts'));

    manager.open(41);
    first.resolve(initial);
    await settle();
    panels[0]!.emit({ type: 'refresh' });

    expect(panels[0]!.posted.at(-1)).toEqual({ type: 'loading', state: initial.state });
    second.resolve(snapshot(41, 'second:1', target('src/second.ts')));
    await settle();
  });

  it('lets only the newest overlapping refresh replace state and target lookup', async () => {
    const first = deferred<TicketChangesSnapshot>();
    const second = deferred<TicketChangesSnapshot>();
    const third = deferred<TicketChangesSnapshot>();
    const { host, panels } = makeHost();
    const openDiff = vi.fn(async () => {});
    const warn = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(third.promise),
      openDiff,
      warn,
    );
    const oldTarget = target('src/old.ts');
    const newTarget = target('src/new.ts');

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'refresh' });
    first.resolve(snapshot(41, 'old:1', oldTarget));
    await settle();
    second.resolve(snapshot(41, 'new:1', newTarget));
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'new:1' });
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'old:1' });
    third.resolve(snapshot(41, 'latest:1', target('src/latest.ts')));
    await settle();

    expect(panels[0]!.posted.filter((message) => message.type === 'state')).toEqual([
      { type: 'state', state: snapshot(41, 'new:1', newTarget).state },
      { type: 'state', state: snapshot(41, 'latest:1', target('src/latest.ts')).state },
    ]);
    expect(openDiff).toHaveBeenCalledWith(newTarget, 2);
    expect(warn).toHaveBeenCalledWith('That change is stale. Refreshing ticket changes…');
  });

  it('coalesces refresh spam into one replacement load and aborts the superseded load', async () => {
    const signals: AbortSignal[] = [];
    const loads: Deferred<TicketChangesSnapshot>[] = [];
    const load = vi.fn((_ticketId: number, signal: AbortSignal) => {
      signals.push(signal);
      const pending = deferred<TicketChangesSnapshot>();
      loads.push(pending);
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        pending.reject(error);
      }, { once: true });
      return pending.promise;
    });
    const { host, panels } = makeHost();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      load,
      async () => {},
      () => {},
      logError,
    );

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'refresh' });
    panels[0]!.emit({ type: 'refresh' });
    panels[0]!.emit({ type: 'refresh' });
    await settle();

    expect(load).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(logError).not.toHaveBeenCalled();

    loads[1]!.resolve(snapshot(41, 'current:1', target('src/current.ts')));
    await settle();
  });

  it('opens only a target from the current snapshot map', async () => {
    const diffTarget = target('src/current.ts');
    const loaded = snapshot(41, 'current:1', diffTarget);
    const { host, panels } = makeHost();
    const openDiff = vi.fn(async (_target: DiffTarget, _column?: number) => {});
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, async () => loaded, openDiff, () => {});

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1', path: '/forged' });
    await settle();

    expect(openDiff).toHaveBeenCalledWith(diffTarget, 2);
    expect(openDiff.mock.calls[0]![0]).toBe(diffTarget);
  });

  /**
   * Every click names the SAME editor group, so a second diff replaces the
   * first instead of opening yet another group beside the last one.
   */
  it('opens every diff in the column anchored to its panel', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const openDiff = vi.fn(async (_target: DiffTarget, _column?: number) => {});
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, async () => loaded, openDiff, () => {});

    manager.open(41);
    await settle();
    panels[0]!.column = 3;
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    await settle();

    expect(openDiff.mock.calls.map((call) => call[1])).toEqual([4, 4]);
  });

  it('puts a validated commit hash on the clipboard', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const clipboard = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      async () => loaded,
      async () => {},
      () => {},
      () => {},
      clipboard,
    );

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'copy-hash', hash: '9f1c2ab' });
    panels[0]!.emit({ type: 'copy-hash', hash: 'not a hash' });
    await settle();

    expect(clipboard).toHaveBeenCalledExactlyOnceWith('9f1c2ab');
  });

  it('warns instead of failing silently when the clipboard write throws', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const warn = vi.fn();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      async () => loaded,
      async () => {},
      warn,
      logError,
      () => { throw new Error('no clipboard'); },
    );

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'copy-hash', hash: '9f1c2ab' });
    await settle();

    expect(warn).toHaveBeenCalledWith('Could not copy 9f1c2ab to the clipboard.');
    expect(logError).toHaveBeenCalledWith('karst: copying a commit hash failed', expect.any(Error));
  });

  it('leaves the column to the host when its panel is hidden', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const openDiff = vi.fn(async (_target: DiffTarget, _column?: number) => {});
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, async () => loaded, openDiff, () => {});

    manager.open(41);
    await settle();
    panels[0]!.column = undefined;
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    await settle();

    expect(openDiff.mock.calls[0]![1]).toBeUndefined();
  });

  it('warns and refreshes for a stale or forged change id', async () => {
    const initial = snapshot(41, 'current:1', target('src/current.ts'));
    const refreshed = snapshot(41, 'next:1', target('src/next.ts'));
    const load = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const { host, panels } = makeHost();
    const warn = vi.fn();
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, load, async () => {}, warn);

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'forged:1' });
    await settle();

    expect(warn).toHaveBeenCalledWith('That change is stale. Refreshing ticket changes…');
    expect(load).toHaveBeenCalledTimes(2);
    expect(panels[0]!.posted.at(-1)).toEqual({ type: 'state', state: refreshed.state });
  });

  it('isolates an openDiff rejection and keeps routing later messages', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const openDiff = vi.fn()
      .mockRejectedValueOnce(new Error('Diff unavailable'))
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      async () => loaded,
      openDiff,
      warn,
      logError,
    );

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    await settle();

    expect(logError).toHaveBeenCalledWith('karst: opening ticket change failed', expect.any(Error));
    expect(warn).toHaveBeenCalledWith('Diff unavailable');
    expect(openDiff).toHaveBeenCalledTimes(2);
  });

  it('warns and refreshes when preparing a trusted target reports it stale', async () => {
    const initial = snapshot(41, 'current:1', target('src/current.ts'));
    const refreshed = snapshot(41, 'next:1', target('src/next.ts'));
    const load = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const stale = new StaleDiffTargetError('the index changed');
    const { host, panels } = makeHost();
    const warn = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      load,
      async () => { throw stale; },
      warn,
    );

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    await settle();

    expect(warn).toHaveBeenCalledWith(stale.message);
    expect(load).toHaveBeenCalledTimes(2);
    expect(panels[0]!.posted.at(-1)).toEqual({ type: 'state', state: refreshed.state });
  });

  it('turns a synchronous load throw into a panel error', async () => {
    const { host, panels } = makeHost();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      () => { throw new Error('Load exploded'); },
      async () => {},
      () => {},
      logError,
    );

    expect(() => manager.open(41)).not.toThrow();
    await settle();

    expect(panels[0]!.posted).toEqual([
      { type: 'loading', state: null },
      { type: 'error', message: 'Load exploded' },
    ]);
    expect(logError).toHaveBeenCalledWith(
      'karst: loading ticket changes failed',
      expect.any(Error),
    );
  });

  it('warns with the reason when openDiff throws synchronously', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const warn = vi.fn();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      async () => loaded,
      () => { throw new Error('Synchronous diff failure'); },
      warn,
      logError,
    );

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
    await settle();

    expect(warn).toHaveBeenCalledWith('Synchronous diff failure');
    expect(logError).toHaveBeenCalledWith(
      'karst: opening ticket change failed',
      expect.any(Error),
    );
  });

  it('posts nothing after disposal and recreates on the next open', async () => {
    const first = deferred<TicketChangesSnapshot>();
    const second = deferred<TicketChangesSnapshot>();
    const { host, panels } = makeHost();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      async () => {},
      () => {},
    );

    manager.open(41);
    await settle();
    panels[0]!.dispose();
    first.resolve(snapshot(41, 'old:1', target('src/old.ts')));
    await settle();
    expect(panels[0]!.posted).toEqual([{ type: 'loading', state: null }]);
    expect(manager.isOpen(41)).toBe(false);

    manager.open(41);
    expect(panels).toHaveLength(2);
    second.resolve(snapshot(41, 'new:1', target('src/new.ts')));
    await settle();
    expect(panels[1]!.posted).toEqual([
      { type: 'loading', state: null },
      { type: 'state', state: snapshot(41, 'new:1', target('src/new.ts')).state },
    ]);
  });

  it('aborts a queued refresh and its in-flight load when the extension shuts down', async () => {
    const signals: AbortSignal[] = [];
    const loads: Deferred<TicketChangesSnapshot>[] = [];
    const load = vi.fn((_ticketId: number, signal: AbortSignal) => {
      signals.push(signal);
      const pending = deferred<TicketChangesSnapshot>();
      loads.push(pending);
      return pending.promise;
    });
    const { host, panels } = makeHost();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      load,
      async () => {},
      () => {},
      logError,
    );

    manager.open(41);
    await settle();
    // Queues a replacement load behind the in-flight one, exactly as a Refresh
    // click during a slow load does.
    panels[0]!.emit({ type: 'refresh' });
    expect(load).toHaveBeenCalledTimes(1);

    manager.dispose();

    expect(signals[0]!.aborted).toBe(true);
    expect(manager.isOpen(41)).toBe(false);

    // The aborted load still settles afterwards; nothing may re-enter refresh
    // and reach the (now closed) store behind the injected loader.
    loads[0]!.resolve(snapshot(41, 'late:1', target('src/late.ts')));
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(panels[0]!.posted).toEqual([{ type: 'loading', state: null }]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('disposes idempotently and posts nothing to a disposed session', async () => {
    const pending = deferred<TicketChangesSnapshot>();
    const { host, panels } = makeHost();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      () => pending.promise,
      async () => {},
      () => {},
    );

    manager.open(41);
    await settle();

    expect(() => {
      manager.dispose();
      manager.dispose();
    }).not.toThrow();

    pending.resolve(snapshot(41, 'late:1', target('src/late.ts')));
    await settle();

    expect(panels[0]!.posted).toEqual([{ type: 'loading', state: null }]);
    // A disposed manager must not resurrect a session either.
    panels[0]!.emit({ type: 'refresh' });
    await settle();
    expect(panels[0]!.posted).toEqual([{ type: 'loading', state: null }]);
  });

  it('never leaks an unhandled rejection when the panel throws while posting state', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const panels: FakePanel[] = [];
      const host: ChangesPanelHost = {
        createPanel: () => {
          const panel = new FakePanel();
          const post = panel.postMessage.bind(panel);
          panel.postMessage = (message: ChangesHostMessage): void => {
            post(message);
            if (message.type === 'state') throw new Error('panel is gone');
          };
          panels.push(panel);
          return panel;
        },
      };
      const loaded = deferred<TicketChangesSnapshot>();
      const logError = vi.fn();
      const manager = new TicketChangesManager(
        host,
        (id) => `Changes ${id}`,
        () => loaded.promise,
        async () => {},
        () => {},
        logError,
      );

      manager.open(41);
      loaded.resolve(snapshot(41, 'current:1', target('src/current.ts')));
      await settle();
      await settle();

      expect(rejections).toEqual([]);
      expect(logError).toHaveBeenCalledWith(
        'karst: ticket changes refresh failed',
        expect.any(Error),
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('never leaks an unhandled rejection when the warn channel throws', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const loaded = snapshot(41, 'current:1', target('src/current.ts'));
      const { host, panels } = makeHost();
      const logError = vi.fn();
      const manager = new TicketChangesManager(
        host,
        (id) => `Changes ${id}`,
        async () => loaded,
        async () => { throw new Error('Diff unavailable'); },
        () => { throw new Error('warn channel is gone'); },
        logError,
      );

      manager.open(41);
      await settle();
      panels[0]!.emit({ type: 'open-diff', changeId: 'current:1' });
      await settle();
      await settle();

      expect(rejections).toEqual([]);
      expect(logError).toHaveBeenCalledWith(
        'karst: ticket changes open failed',
        expect.any(Error),
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('aborts the active load when its panel is disposed', async () => {
    let signal: AbortSignal | undefined;
    const load = vi.fn((_ticketId: number, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<TicketChangesSnapshot>((_resolve, reject) => {
        currentSignal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const { host, panels } = makeHost();
    const logError = vi.fn();
    const manager = new TicketChangesManager(
      host,
      (id) => `Changes ${id}`,
      load,
      async () => {},
      () => {},
      logError,
    );

    manager.open(41);
    await settle();
    panels[0]!.dispose();
    await settle();

    expect(signal?.aborted).toBe(true);
    expect(logError).not.toHaveBeenCalled();
    expect(panels[0]!.posted).toEqual([{ type: 'loading', state: null }]);
  });
});
