import { describe, expect, it, vi } from 'vitest';
import type { ResourceMonitor, ResourceReading } from '../../runtime/resourceMonitor.js';
import type { WorktreeDiskCache } from '../../runtime/worktreeDisk.js';
import type { ResourcesHostMessage } from './messages.js';
import { ResourcesPanelManager } from './panel.js';
import type { ResourcesPanel, ResourcesPanelHost } from './panel.js';

const baseReading: ResourceReading = {
  supported: true,
  degraded: false,
  inventory: null,
  waste: [],
  history: [],
  skipped: 0,
  fastLane: false,
};

function fakeMonitor(): {
  monitor: ResourceMonitor;
  listeners: Set<(r: ResourceReading) => void>;
  setPanelVisible: ReturnType<typeof vi.fn>;
  reading: ReturnType<typeof vi.fn>;
  refreshNow: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  notify: (r: ResourceReading) => void;
} {
  const listeners = new Set<(r: ResourceReading) => void>();
  const monitor = {
    setPanelVisible: vi.fn(),
    onReading: vi.fn((l: (r: ResourceReading) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    reading: vi.fn(() => baseReading),
    refreshNow: vi.fn(async () => {}),
    kill: vi.fn(async () => 'killed'),
  } as unknown as ResourceMonitor;
  return {
    monitor,
    listeners,
    setPanelVisible: monitor.setPanelVisible as ReturnType<typeof vi.fn>,
    reading: monitor.reading as ReturnType<typeof vi.fn>,
    refreshNow: monitor.refreshNow as ReturnType<typeof vi.fn>,
    kill: monitor.kill as ReturnType<typeof vi.fn>,
    notify: (r) => {
      for (const l of listeners) l(r);
    },
  };
}

function fakePanel(): {
  panel: ResourcesPanel;
  posts: ResourcesHostMessage[];
  receive: (m: unknown) => void;
  dispose: () => void;
} {
  let receiveHandler: ((m: unknown) => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  const posts: ResourcesHostMessage[] = [];
  const panel = {
    reveal: vi.fn(),
    postMessage: vi.fn((m: ResourcesHostMessage) => {
      posts.push(m);
    }),
    onDidReceiveMessage: vi.fn((h: (m: unknown) => void) => {
      receiveHandler = h;
    }),
    onDidDispose: vi.fn((h: () => void) => {
      disposeHandler = h;
    }),
  } as unknown as ResourcesPanel;
  return {
    panel,
    posts,
    receive: (m) => receiveHandler?.(m),
    dispose: () => disposeHandler?.(),
  };
}

function fakeDisk(): { disk: WorktreeDiskCache; measureAll: ReturnType<typeof vi.fn> } {
  const measureAll = vi.fn(
    async (paths: readonly string[], signal: AbortSignal, onEach: (u: { path: string; bytes: number; measuredMs: number }) => void) => {
      for (const p of paths) {
        if (signal.aborted) return;
        onEach({ path: p, bytes: 100, measuredMs: 1 });
      }
    },
  );
  return { disk: { measureAll } as unknown as WorktreeDiskCache, measureAll };
}

function hostFor(panel: ResourcesPanel): ResourcesPanelHost {
  return { createPanel: vi.fn(() => panel) };
}

describe('ResourcesPanelManager', () => {
  it('opens a panel, turns on the fast lane, and forces a refresh', () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
    });
    manager.open();
    expect(m.setPanelVisible).toHaveBeenCalledWith(true);
    expect(m.refreshNow).toHaveBeenCalledTimes(1);
    expect(p.posts.some((x) => x.type === 'state')).toBe(true);
  });

  it('reveals an existing panel on a second open without re-subscribing', () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
    });
    manager.open();
    const callsBefore = m.setPanelVisible.mock.calls.length;
    manager.open();
    expect(p.panel.reveal).toHaveBeenCalledTimes(1);
    expect(m.setPanelVisible.mock.calls.length).toBe(callsBefore);
  });

  it('posts a state message for every reading from the monitor', () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
    });
    manager.open();
    const before = p.posts.filter((x) => x.type === 'state').length;
    m.notify({ ...baseReading, degraded: true });
    const states = p.posts.filter((x) => x.type === 'state');
    expect(states.length).toBe(before + 1);
  });

  it('releases the fast lane and unsubscribes on dispose', () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
    });
    manager.open();
    p.dispose();
    expect(m.setPanelVisible).toHaveBeenLastCalledWith(false);
    const before = p.posts.filter((x) => x.type === 'state').length;
    m.notify({ ...baseReading, degraded: true });
    expect(p.posts.filter((x) => x.type === 'state').length).toBe(before);
  });

  it('killServer goes through the confirm gate and is cancelled when declined', async () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const confirm = vi.fn(async () => false);
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
      confirm,
    });
    manager.open();
    p.receive({ type: 'kill-server', serverId: 1, requestId: 'k1-abc' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirm).toHaveBeenCalledWith('Stop this server process?');
    expect(m.kill).not.toHaveBeenCalled();
    expect(p.posts.some((x) => x.type === 'action-result' && x.ok)).toBe(true);
  });

  it('killServer reports the outcome wording when the process was not stopped', async () => {
    const m = fakeMonitor();
    m.kill.mockResolvedValue('denied');
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
    });
    manager.open();
    p.receive({ type: 'kill-server', serverId: 1, requestId: 'k1-abc' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.kill).toHaveBeenCalledWith(1);
    const result = p.posts.find((x) => x.type === 'action-result') as Extract<
      ResourcesHostMessage,
      { type: 'action-result' }
    >;
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Refused — the process is still running');
  });

  it('killServer acks success when the process was stopped', async () => {
    const m = fakeMonitor();
    m.kill.mockResolvedValue('killed');
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
    });
    manager.open();
    p.receive({ type: 'kill-server', serverId: 1, requestId: 'k1-abc' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = p.posts.find((x) => x.type === 'action-result') as Extract<
      ResourcesHostMessage,
      { type: 'action-result' }
    >;
    expect(result.ok).toBe(true);
  });

  it('measureDisk pushes a disk message per onEach, in order', async () => {
    const m = fakeMonitor();
    const d = fakeDisk();
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: d.disk,
      worktreePaths: () => ['/a', '/b'],
    });
    manager.open();
    p.receive({ type: 'measure-disk', requestId: 'k1-abc' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.measureAll).toHaveBeenCalled();
    const diskMessages = p.posts.filter((x) => x.type === 'disk') as Extract<
      ResourcesHostMessage,
      { type: 'disk' }
    >[];
    expect(diskMessages).toHaveLength(2);
    expect(diskMessages[1]!.rows.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('aborts an in-flight disk pass on dispose', async () => {
    const m = fakeMonitor();
    const d = fakeDisk();
    d.measureAll.mockImplementation(() => new Promise(() => {}));
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: d.disk,
      worktreePaths: () => ['/a', '/b'],
    });
    manager.open();
    p.receive({ type: 'measure-disk', requestId: 'k1-abc' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.dispose();
    expect(d.measureAll).toHaveBeenCalled();
    expect(d.measureAll.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it('resolves attributed ticket ids through the injected identity dep', async () => {
    const m = fakeMonitor();
    m.reading.mockReturnValue({
      ...baseReading,
      inventory: {
        takenMs: 100,
        cwdProbes: 0,
        attributed: [
          {
            pid: 100,
            kind: 'server',
            ticketId: 7,
            label: 'web',
            serverId: 1,
            attribution: 'attributable',
            cost: { pid: 100, rssBytes: 60, cpuPct: 50, procCount: 1, startedMs: 1 },
            cwd: '/wt/x',
            comm: 'npm',
          },
        ],
        unattributed: [],
        totals: { rssBytes: 60, cpuPct: 50 },
      },
      waste: [],
    });
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
      ticketIdentity: (ids) => new Map(ids.map((id) => [id, { key: `K-${id}`, title: `T-${id}` }])),
    });
    manager.open();
    const state = manager.state();
    expect(state.rows[0]).toMatchObject({ ticketKey: 'K-7', ticketTitle: 'T-7' });
  });

  it('carries the scope label into the pushed state', async () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
      scopeLabel: () => 'Project karst · this window',
    });
    manager.open();
    const state = p.posts.find((x) => x.type === 'state') as Extract<
      ResourcesHostMessage,
      { type: 'state' }
    >;
    expect(state.state.scopeLabel).toBe('Project karst · this window');
  });
});
