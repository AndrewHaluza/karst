import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Store } from '../store/db.js';

const m = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
  parse: vi.fn((u: string) => ({ parsed: u })),
  status: { command: '', text: '', tooltip: '', show: vi.fn(), hide: vi.fn() },
  createStatusBarItem: vi.fn(),
  makeServersHost: vi.fn(),
  inventory: vi.fn(),
  ensureBaseline: vi.fn(),
  stopServer: vi.fn(),
}));
vi.mock('vscode', () => ({
  window: { showWarningMessage: m.showWarningMessage, createStatusBarItem: m.createStatusBarItem },
  env: { openExternal: m.openExternal, clipboard: { writeText: m.writeText } },
  Uri: { parse: m.parse },
  StatusBarAlignment: { Left: 1 },
}));
vi.mock('./ops/serversHostOps.js', () => ({ makeServersHost: m.makeServersHost }));
vi.mock('../runtime/baseline.js', () => ({ ensureBaseline: m.ensureBaseline }));
vi.mock('../runtime/supervisor.js', () => ({ stopServer: m.stopServer }));

import { createServersBinding, type ServersBindingDeps } from './serversBinding.js';

const running = (n: number) => ({
  shared: Array.from({ length: n }, () => ({ status: 'running' })),
  tickets: [],
});

describe('createServersBinding', () => {
  let deps: ServersBindingDeps;
  let subs: unknown[];
  beforeEach(() => {
    vi.clearAllMocks();
    m.status.show.mockClear();
    m.status.hide.mockClear();
    m.createStatusBarItem.mockReturnValue(m.status);
    m.makeServersHost.mockImplementation(() => ({ inventory: m.inventory }));
    subs = [];
    deps = {
      context: { subscriptions: subs } as never,
      store: {} as Store,
      notify: vi.fn() as never,
      debug: vi.fn(),
      projectId: () => 1,
      manifest: () => undefined,
      loadManifest: async () => null,
      afterServerChange: vi.fn(),
      stopTicketServers: async () => undefined,
      openTicketLogs: vi.fn(),
      openLogs: vi.fn(),
    };
  });

  const shared = () => (m.makeServersHost.mock.calls[0]![0] as never as {
    shared: { confirm: (a: string, b: string) => Promise<boolean>; ensureBaseline: (...a: unknown[]) => unknown; stopServer: (...a: unknown[]) => unknown };
    rows: { openExternal: (u: string) => void; copyText: (t: string) => void; sandbox?: unknown; userUatWithheld?: unknown };
  });

  it('creates a left status item bound to the Servers command and registers it', () => {
    createServersBinding(deps);
    expect(m.createStatusBarItem).toHaveBeenCalledWith(1, 39);
    expect(m.status.command).toBe('karst.openServers');
    expect(subs).toEqual([m.status]);
  });

  it('confirms with a modal and resolves true only on the action label', async () => {
    createServersBinding(deps);
    m.showWarningMessage.mockResolvedValueOnce('Stop');
    expect(await shared().shared.confirm('sure?', 'Stop')).toBe(true);
    expect(m.showWarningMessage).toHaveBeenCalledWith('sure?', { modal: true }, 'Stop');
    m.showWarningMessage.mockResolvedValueOnce(undefined);
    expect(await shared().shared.confirm('sure?', 'Stop')).toBe(false);
  });

  it('passes the debug sink to baseline and stop', () => {
    createServersBinding(deps);
    shared().shared.ensureBaseline('s', 'm', 'svc');
    expect(m.ensureBaseline).toHaveBeenCalledWith('s', 'm', 'svc', { debug: deps.debug });
    shared().shared.stopServer('s', 5);
    expect(m.stopServer).toHaveBeenCalledWith('s', 5, { debug: deps.debug });
  });

  it('opens urls and copies text through the host env', () => {
    createServersBinding(deps);
    shared().rows.openExternal('http://x');
    expect(m.openExternal).toHaveBeenCalledWith({ parsed: 'http://x' });
    shared().rows.copyText('abc');
    expect(m.writeText).toHaveBeenCalledWith('abc');
  });

  it('adds sandbox and userUatWithheld to the rows only when given', () => {
    createServersBinding(deps);
    expect('sandbox' in shared().rows).toBe(false);
    expect('userUatWithheld' in shared().rows).toBe(false);
    m.makeServersHost.mockClear();
    const sandbox = {} as never;
    const userUatWithheld = (() => false) as never;
    createServersBinding({ ...deps, sandbox, userUatWithheld });
    expect(shared().rows.sandbox).toBe(sandbox);
    expect(shared().rows.userUatWithheld).toBe(userUatWithheld);
  });

  it('shows a pluralised indicator while servers run', () => {
    const b = createServersBinding(deps);
    m.inventory.mockReturnValue(running(2));
    b.updateStatus();
    expect(m.status.text).toBe('$(server) Karst: 2 servers');
    expect(m.status.tooltip).toContain('2 shared');
    expect(m.status.show).toHaveBeenCalled();
  });

  it('hides the item when nothing runs or the inventory throws', () => {
    const b = createServersBinding(deps);
    m.inventory.mockReturnValue(running(0));
    b.updateStatus();
    m.inventory.mockImplementation(() => { throw new Error('x'); });
    b.updateStatus();
    expect(m.status.hide).toHaveBeenCalledTimes(2);
    expect(m.status.show).not.toHaveBeenCalled();
  });
});
