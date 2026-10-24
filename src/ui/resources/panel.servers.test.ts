import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceMonitor, ResourceReading } from '../../runtime/resourceMonitor.js';
import type { WorktreeDiskCache } from '../../runtime/worktreeDisk.js';
import type { ServerInventory } from '../../store/serverInventory.js';
import { TAB_TITLE_MAX } from '../../model/tabTitle.js';
import type { ActionResultMessage } from '../../model/actionResult.js';
import type { ResourcesHostMessage } from './messages.js';
import {
  PANEL_TITLE,
  ResourcesPanelManager,
  type ResourcesPanel,
  type ResourcesPanelHost,
  type ServersHost,
} from './panel.js';

const reading: ResourceReading = {
  supported: true, degraded: false, inventory: null, waste: [], history: [], skipped: 0, fastLane: false,
};

function fakeMonitor(): ResourceMonitor {
  return {
    setPanelVisible: vi.fn(),
    onReading: vi.fn(() => () => {}),
    reading: vi.fn(() => reading),
    refreshNow: vi.fn(async () => {}),
    kill: vi.fn(async () => 'killed'),
  } as unknown as ResourceMonitor;
}

function fakePanel() {
  let receive: ((m: unknown) => void) | undefined;
  let dispose: (() => void) | undefined;
  const posts: ResourcesHostMessage[] = [];
  const panel = {
    reveal: vi.fn(),
    postMessage: vi.fn((m: ResourcesHostMessage) => void posts.push(m)),
    onDidReceiveMessage: vi.fn((h: (m: unknown) => void) => void (receive = h)),
    onDidDispose: vi.fn((h: () => void) => void (dispose = h)),
  } as unknown as ResourcesPanel;
  return {
    panel, posts,
    send: (m: unknown) => receive?.(m),
    dispose: () => dispose?.(),
    ofType: <T extends ResourcesHostMessage['type']>(t: T) =>
      posts.filter((p): p is Extract<ResourcesHostMessage, { type: T }> => p.type === t),
    results: () => posts.filter((p): p is ActionResultMessage => p.type === 'action-result'),
  };
}

const sv = (id: number, repo: string, status = 'running') => ({
  id, repo, host: 'localhost', port: 3000 + id, status, startedAt: null,
  logPath: null, container: null, cwd: null, sandbox: null,
});

function inventory(): ServerInventory {
  return {
    shared: [{ ...sv(1, 'api'), pinned: false, baseBranch: 'develop', dependents: [] }],
    tickets: [{
      ticketId: 7, key: 'T-7', title: 'seven', stage: 'impl', archived: false, done: false,
      dependencyDown: false, downServices: [], servers: [sv(2, 'web')],
    }],
  };
}

function fakeServers(over: Partial<ServersHost> = {}) {
  const calls = {
    inventory: vi.fn((): ServerInventory | undefined => inventory()),
    startShared: vi.fn(async () => {}), restartShared: vi.fn(async () => {}), stopShared: vi.fn(async () => {}),
    setPinned: vi.fn(), stopIdle: vi.fn(async () => {}), startRow: vi.fn(async () => {}),
    restartRow: vi.fn(async () => {}), stopRow: vi.fn(async () => {}), openRow: vi.fn(), copyRow: vi.fn(),
    stopTicket: vi.fn(async () => {}), openTicketLogs: vi.fn(), openLogs: vi.fn(),
  };
  return { host: { ...calls, ...over } as unknown as ServersHost, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(servers?: ServersHost, extra: Record<string, unknown> = {}) {
  const p = fakePanel();
  const createPanel = vi.fn((_title: string) => p.panel);
  const host: ResourcesPanelHost = { createPanel };
  const manager = new ResourcesPanelManager(host, {
    monitor: fakeMonitor(),
    disk: { measureAll: vi.fn() } as unknown as WorktreeDiskCache,
    worktreePaths: () => [],
    ...(servers ? { servers } : {}),
    ...extra,
  });
  return { p, manager, createPanel };
}

describe('Servers tab — panel lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('names the panel "Servers & resources" and passes the title through tabTitle', () => {
    const { manager, createPanel } = setup(fakeServers().host);
    manager.open('servers');
    expect(createPanel).toHaveBeenCalledWith(PANEL_TITLE);
    expect(PANEL_TITLE).toBe('Servers & resources');
  });

  it('caps the editor-tab title at TAB_TITLE_MAX when the title runs long', () => {
    const long = `${PANEL_TITLE} — a project with a very long descriptive name 🚀🚀🚀`;
    expect(Array.from(long).length).toBeGreaterThan(TAB_TITLE_MAX);
    const { manager, createPanel } = setup(fakeServers().host, { panelTitle: () => long });
    manager.open('servers');
    const title = createPanel.mock.calls[0]![0];
    expect(Array.from(title).length).toBeLessThanOrEqual(TAB_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
  });

  it('opens on the requested tab: the first request-state carries show-tab', () => {
    const { p, manager } = setup(fakeServers().host);
    manager.open('servers');
    p.send({ type: 'request-state' });
    expect(p.ofType('show-tab')).toEqual([{ type: 'show-tab', tab: 'servers' }]);
    p.send({ type: 'request-state' });
    expect(p.ofType('show-tab')).toHaveLength(1);
  });

  it('defaults to the Resources tab', () => {
    const { p, manager } = setup(fakeServers().host);
    manager.open();
    p.send({ type: 'request-state' });
    expect(p.ofType('show-tab')).toEqual([{ type: 'show-tab', tab: 'resources' }]);
  });

  it('a repeat open reveals the one panel, switches tab, and mints no second webview or subscriber', () => {
    const { p, manager, createPanel } = setup(fakeServers().host);
    manager.open('resources');
    manager.open('servers');
    expect(createPanel).toHaveBeenCalledTimes(1);
    expect(p.panel.reveal).toHaveBeenCalledTimes(1);
    expect(p.panel.onDidReceiveMessage).toHaveBeenCalledTimes(1);
    expect(p.ofType('show-tab')).toEqual([{ type: 'show-tab', tab: 'servers' }]);
  });

  it('posts a Servers state on open and re-reads on the interval, skipping unchanged reads', () => {
    vi.useFakeTimers();
    const fs = fakeServers();
    const { p, manager } = setup(fs.host, { serversPollMs: 1000 });
    manager.open('servers');
    expect(p.ofType('servers')).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(p.ofType('servers')).toHaveLength(1);
    expect(fs.calls.inventory.mock.calls.length).toBeGreaterThanOrEqual(4);
    fs.calls.inventory.mockReturnValue({ ...inventory(), shared: [] });
    vi.advanceTimersByTime(1000);
    expect(p.ofType('servers')).toHaveLength(2);
    expect(p.ofType('servers')[1]!.state.shared).toEqual([]);
  });

  it('stops polling on dispose', () => {
    vi.useFakeTimers();
    const fs = fakeServers();
    const { p, manager } = setup(fs.host, { serversPollMs: 1000 });
    manager.open('servers');
    p.dispose();
    const reads = fs.calls.inventory.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(fs.calls.inventory.mock.calls.length).toBe(reads);
  });

  it('refreshServers repaints immediately (afterServerChange)', () => {
    const fs = fakeServers();
    const { p, manager } = setup(fs.host);
    manager.open('servers');
    fs.calls.inventory.mockReturnValue({ ...inventory(), tickets: [] });
    manager.refreshServers();
    expect(p.ofType('servers').at(-1)!.state.groups).toEqual([]);
  });

  it('renders unavailable, never throws, when there is no host, no project, or the read throws', () => {
    expect(setup().manager.serversState()).toMatchObject({ available: false });
    const none = fakeServers({ inventory: () => undefined });
    expect(setup(none.host).manager.serversState().unavailableReason).toContain('karst.yml');
    const boom = fakeServers({ inventory: () => { throw new Error('db'); } });
    const logError = vi.fn();
    expect(setup(boom.host, { logError }).manager.serversState().unavailableReason).toContain('could not be read');
    expect(logError).toHaveBeenCalled();
  });

  it('carries the scope label into the state', () => {
    const { manager } = setup(fakeServers().host, { scopeLabel: () => 'Project P · this window' });
    expect(manager.serversState().scopeLabel).toBe('Project P · this window');
  });
});

describe('Servers tab — action dispatch', () => {
  let fs: ReturnType<typeof fakeServers>;
  let p: ReturnType<typeof setup>['p'];
  beforeEach(() => {
    fs = fakeServers();
    const s = setup(fs.host);
    s.manager.open('servers');
    p = s.p;
  });

  it.each([
    ['shared-start', { repo: 'api' }, 'startShared', ['api']],
    ['shared-restart', { repo: 'api' }, 'restartShared', ['api']],
    ['shared-stop', { repo: 'api' }, 'stopShared', ['api']],
    ['shared-pin', { repo: 'api', pinned: true }, 'setPinned', ['api', true]],
    ['stop-idle', {}, 'stopIdle', []],
    ['server-start', { serverId: 2 }, 'startRow', [2]],
    ['server-restart', { serverId: 2 }, 'restartRow', [2]],
    ['server-stop', { serverId: 2 }, 'stopRow', [2]],
    ['server-open', { serverId: 2 }, 'openRow', [2]],
    ['server-copy', { serverId: 2 }, 'copyRow', [2]],
    ['ticket-stop-all', { ticketId: 7 }, 'stopTicket', [7]],
    ['ticket-logs', { ticketId: 7 }, 'openTicketLogs', [7]],
    ['open-logs', {}, 'openLogs', []],
  ] as const)('%s → %s', async (type, args, method, expected) => {
    p.send({ type, ...args, requestId: 'r1' });
    await flush();
    expect(fs.calls[method as keyof typeof fs.calls]).toHaveBeenCalledWith(...expected);
    expect(p.results()).toEqual([{ type: 'action-result', requestId: 'r1', ok: true }]);
  });

  it('Refresh re-reads the Servers tab as well as the monitor', async () => {
    const before = p.ofType('servers').length;
    fs.calls.inventory.mockReturnValue({ ...inventory(), shared: [] });
    p.send({ type: 'refresh', requestId: 'rf' });
    await flush();
    expect(p.ofType('servers').length).toBeGreaterThan(before);
    expect(p.ofType('servers').at(-1)!.state.shared).toEqual([]);
    expect(p.results()).toEqual([{ type: 'action-result', requestId: 'rf', ok: true }]);
  });

  it('repaints after a verb, win or lose', async () => {
    const before = p.ofType('servers').length;
    fs.calls.stopShared.mockRejectedValueOnce(new Error('Refused'));
    p.send({ type: 'shared-stop', repo: 'api', requestId: 'r2' });
    await flush();
    expect(p.ofType('servers').length).toBeGreaterThan(before);
  });

  it('turns a failing verb into one failed action-result carrying the reason', async () => {
    fs.calls.restartShared.mockRejectedValueOnce(new Error('api was not stopped — its process is still running.'));
    p.send({ type: 'shared-restart', repo: 'api', requestId: 'r3' });
    await flush();
    expect(p.results()).toEqual([
      { type: 'action-result', requestId: 'r3', ok: false, message: 'api was not stopped — its process is still running.' },
    ]);
  });

  it('keeps a pending verb pending until its promise settles', async () => {
    let release!: () => void;
    fs.calls.startShared.mockReturnValueOnce(new Promise<void>((r) => void (release = r)));
    p.send({ type: 'shared-start', repo: 'api', requestId: 'r4' });
    await flush();
    expect(p.results()).toEqual([]);
    release();
    await flush();
    expect(p.results()).toEqual([{ type: 'action-result', requestId: 'r4', ok: true }]);
  });

  it('refuses a ticket row that vanished mid-action, by name, without calling the op', async () => {
    p.send({ type: 'server-stop', serverId: 999, requestId: 'r5' });
    await flush();
    expect(fs.calls.stopRow).not.toHaveBeenCalled();
    expect(p.results()).toEqual([
      expect.objectContaining({ requestId: 'r5', ok: false, message: expect.stringContaining('no longer in the list') }),
    ]);
  });

  it.each(['server-start', 'server-restart'] as const)('refuses %s for a vanished row', async (type) => {
    p.send({ type, serverId: 999, requestId: 'r6' });
    await flush();
    expect(fs.calls.startRow).not.toHaveBeenCalled();
    expect(fs.calls.restartRow).not.toHaveBeenCalled();
    expect(p.results()[0]).toMatchObject({ ok: false });
  });

  it('refuses Stop all for a ticket with nothing running', async () => {
    fs.calls.inventory.mockReturnValue({
      ...inventory(),
      tickets: [{ ...inventory().tickets[0]!, servers: [sv(2, 'web', 'stopped')] }],
    });
    p.send({ type: 'ticket-stop-all', ticketId: 7, requestId: 'r7' });
    await flush();
    expect(fs.calls.stopTicket).not.toHaveBeenCalled();
    expect(p.results()[0]).toMatchObject({ ok: false, message: expect.stringContaining('no running servers') });
  });

  it('fails every Servers verb cleanly when the window has no servers host', async () => {
    const s = setup();
    s.manager.open('servers');
    s.p.send({ type: 'shared-start', repo: 'api', requestId: 'r8' });
    await flush();
    expect(s.p.results()[0]).toMatchObject({ ok: false, message: expect.stringContaining('not available') });
  });

  it('ignores malformed verbs (no result, no call)', async () => {
    p.send({ type: 'server-stop', serverId: 'x', requestId: 'r9' });
    p.send({ type: 'shared-pin', repo: 'api', pinned: 'yes', requestId: 'r10' });
    await flush();
    expect(fs.calls.stopRow).not.toHaveBeenCalled();
    expect(fs.calls.setPinned).not.toHaveBeenCalled();
    expect(p.results()).toEqual([]);
  });
});
