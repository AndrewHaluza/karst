import { describe, expect, it, vi } from 'vitest';
import type { DiffTarget } from './git.js';
import type { ChangesHostMessage } from './messages.js';
import { TicketChangesManager, type ChangesPanel, type ChangesPanelHost } from './panel.js';
import type { TicketChangesSnapshot, TicketChangesState } from './snapshot.js';

class FakePanel implements ChangesPanel {
  revealed = 0;
  posted: ChangesHostMessage[] = [];
  private messageHandler?: (message: unknown) => void;
  private disposeHandler?: () => void;

  reveal(): void { this.revealed += 1; }
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
    binaryCheck: { kind: 'untracked', path },
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
  await Promise.resolve();
  await Promise.resolve();
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
    panels[0]!.emit({ type: 'refresh' });
    second.resolve(snapshot(41, 'new:1', newTarget));
    await settle();
    first.resolve(snapshot(41, 'old:1', oldTarget));
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
    expect(openDiff).toHaveBeenCalledWith(newTarget);
    expect(warn).toHaveBeenCalledWith('That change is stale. Refreshing ticket changes…');
  });

  it('opens only a target from the current snapshot map', async () => {
    const loaded = snapshot(41, 'current:1', target('src/current.ts'));
    const { host, panels } = makeHost();
    const openDiff = vi.fn(async () => {});
    const manager = new TicketChangesManager(host, (id) => `Changes ${id}`, async () => loaded, openDiff, () => {});

    manager.open(41);
    await settle();
    panels[0]!.emit({ type: 'open-diff', changeId: 'current:1', path: '/forged' });
    await settle();

    expect(openDiff).toHaveBeenCalledWith(loaded.targets.get('current:1'));
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
});
