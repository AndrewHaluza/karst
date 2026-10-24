import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { manifest, runnableRepo } from '../../manifest/fixtures.js';
import { makeServersHost, type ServersHostDeps } from './serversHostOps.js';
import type { Notify } from './notify.js';

const M = manifest({ api: runnableRepo() });

describe('makeServersHost', () => {
  let store: Store;
  let deps: ServersHostDeps;
  const after = vi.fn();
  const stopTicketServers = vi.fn(async () => {});
  const openExternal = vi.fn();
  const copyText = vi.fn();
  let projectId: number | undefined;
  let current: typeof M | undefined;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = 1;
    current = M;
    vi.clearAllMocks();
    const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) } as unknown as Notify;
    deps = {
      store,
      projectId: () => projectId,
      manifest: () => current,
      shared: {
        store, notify, loadManifest: async () => M, afterServerChange: after,
        ensureBaseline: vi.fn(async () => {}),
        stopServer: vi.fn(async (st: Store, id: number) => void st.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(id)),
        confirm: vi.fn(async () => true),
      },
      rows: {
        store, notify, afterServerChange: after, loadManifest: async () => M,
        openExternal, copyText, debug: () => {},
      },
      stopTicketServers,
      openTicketLogs: vi.fn(),
      openLogs: vi.fn(),
    };
  });
  afterEach(() => store.close());

  it('reads the project inventory, or undefined without a project or manifest', () => {
    const host = makeServersHost(deps);
    expect(host.inventory()).toEqual({ shared: [], tickets: [] });
    projectId = undefined;
    expect(host.inventory()).toBeUndefined();
    projectId = 1;
    current = undefined;
    expect(host.inventory()).toBeUndefined();
  });

  it('opens and copies a running row through the shared helpers', () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const id = Number(
      store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (?, 'api', 'localhost', 3001, 1, 'running')").run(t.id).lastInsertRowid,
    );
    const host = makeServersHost(deps);
    host.openRow(id);
    host.copyRow(id);
    expect(openExternal).toHaveBeenCalledWith('http://localhost:3001');
    expect(copyText).toHaveBeenCalledWith('http://localhost:3001');
  });

  it('stops a ticket through the injected stopper and repaints', async () => {
    await makeServersHost(deps).stopTicket(5);
    expect(stopTicketServers).toHaveBeenCalledWith(5);
    expect(after).toHaveBeenCalledOnce();
  });

  it('pins through the shared ops and delegates logs', () => {
    const host = makeServersHost(deps);
    host.setPinned('api', true);
    expect(store.db.prepare('SELECT repo FROM baseline_pins').all()).toEqual([{ repo: 'api' }]);
    host.openTicketLogs(3);
    host.openLogs();
    expect(deps.openTicketLogs).toHaveBeenCalledWith(3);
    expect(deps.openLogs).toHaveBeenCalled();
  });

  it('delegates every shared verb to its op (start / restart / stop / stop idle)', async () => {
    const host = makeServersHost(deps);
    const running = () =>
      store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (NULL, 'api', 'localhost', 3000, 1, 'running')").run();
    await host.startShared('api');
    expect(deps.shared.ensureBaseline).toHaveBeenCalledWith(store, M, 'api');
    running();
    await host.restartShared('api');
    expect(deps.shared.stopServer).toHaveBeenCalledTimes(1);
    store.db.prepare("UPDATE servers SET status = 'running', pid = 1 WHERE repo = 'api'").run();
    await host.stopShared('api');
    expect(deps.shared.stopServer).toHaveBeenCalledTimes(2);
    store.db.prepare("UPDATE servers SET status = 'running', pid = 1 WHERE repo = 'api'").run();
    await host.stopIdle();
    expect(deps.shared.stopServer).toHaveBeenCalledTimes(3);
    expect(deps.shared.confirm).toHaveBeenCalledTimes(3);
  });

  it('delegates ticket-row start / restart / stop to the row ops', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const id = Number(
      store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (?, 'api', 'localhost', 3001, 1, 'stopped')").run(t.id).lastInsertRowid,
    );
    const host = makeServersHost(deps);
    // The row ops reject a row they cannot start (no worktree recorded) with their own message.
    await expect(host.startRow(id)).rejects.toThrow('has no worktree');
    await expect(host.restartRow(id)).rejects.toThrow('has no worktree');
    await host.stopRow(id);
    expect(after).toHaveBeenCalled();
  });

  it('a stale Start on a ticket row rejects instead of silently doing nothing', async () => {
    await expect(makeServersHost(deps).startRow(404)).rejects.toThrow('no longer exists');
  });
});
