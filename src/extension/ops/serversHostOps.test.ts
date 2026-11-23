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
      sweepNow: vi.fn(async () => {}),
      openTicketLogs: vi.fn(),
      openSharedLogs: vi.fn(),
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

  it('copies the bare address of a TCP row instead of inventing an http URL (RS-14)', () => {
    current = manifest({ api: runnableRepo({ health: 'tcp://localhost:3001' }) });
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const id = Number(
      store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (?, 'api', 'localhost', 3001, 1, 'running')").run(t.id).lastInsertRowid,
    );
    makeServersHost(deps).copyRow(id);
    expect(copyText).toHaveBeenCalledWith('localhost:3001');
  });

  const seedTicketRows = (key: string, repos: string[]): number => {
    const t = createTicket(store, { key, title: key, projectId: 1 });
    for (const repo of repos) {
      store.db
        .prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (?, ?, 'localhost', 3001, 1, 'running')")
        .run(t.id, repo);
    }
    return t.id;
  };

  it('stops a ticket through the injected stopper after the confirm, and repaints', async () => {
    const id = seedTicketRows('FEAT-12', ['api']);
    await makeServersHost(deps).stopTicket(id);
    expect(deps.shared.confirm).toHaveBeenCalledWith('Stop the 1 server of FEAT-12 (api)?', 'Stop servers');
    expect(stopTicketServers).toHaveBeenCalledWith(id);
    expect(after).toHaveBeenCalledOnce();
  });

  it('names the count and the services of a 3-server ticket in the confirm', async () => {
    const id = seedTicketRows('FEAT-12', ['api', 'web', 'worker']);
    await makeServersHost(deps).stopTicket(id);
    expect(deps.shared.confirm).toHaveBeenCalledWith('Stop the 3 servers of FEAT-12 (api, web, worker)?', 'Stop servers');
  });

  it('says the agent UAT stops too only when it is withheld for that ticket', async () => {
    const id = seedTicketRows('FEAT-12', ['api']);
    deps = { ...deps, rows: { ...deps.rows, userUatWithheld: (t) => t === id } };
    await makeServersHost(deps).stopTicket(id);
    expect(deps.shared.confirm).toHaveBeenCalledWith(
      'Stop the 1 server of FEAT-12 (api)? The agent UAT on this ticket stops too.',
      'Stop servers',
    );
  });

  it('stops nothing when the user cancels the confirm', async () => {
    const id = seedTicketRows('FEAT-12', ['api']);
    vi.mocked(deps.shared.confirm).mockResolvedValueOnce(false);
    await makeServersHost(deps).stopTicket(id);
    expect(stopTicketServers).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('holds "stopping" on the ticket rows while Stop all runs, then clears it', async () => {
    const id = seedTicketRows('FEAT-12', ['api']);
    const host = makeServersHost(deps);
    let during: unknown;
    stopTicketServers.mockImplementationOnce(async () => {
      during = [...(host.viewHints().rowVerbs ?? new Map()).values()];
    });
    await host.stopTicket(id);
    expect(during).toEqual(['stopping']);
    expect(host.viewHints().rowVerbs?.size).toBe(0);
  });

  it('holds "starting" on a row while Start runs and clears it when the start fails', async () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const id = Number(
      store.db.prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (?, 'api', 'localhost', 3001, 1, 'stopped')").run(t.id).lastInsertRowid,
    );
    const host = makeServersHost(deps);
    const run = host.startRow(id);
    expect(host.viewHints().rowVerbs?.get(id)).toBe('starting');
    await expect(run).rejects.toThrow();
    expect(host.viewHints().rowVerbs?.has(id)).toBe(false);
  });

  it('holds "stopping" on a shared row while its Stop runs', async () => {
    const host = makeServersHost(deps);
    const run = host.stopShared('api');
    expect(host.viewHints().sharedVerbs?.get('api')).toBe('stopping');
    await run.catch(() => {});
    expect(host.viewHints().sharedVerbs?.has('api')).toBe(false);
  });

  it('gives each unit its declared health budget, else undefined', () => {
    current = manifest({ api: runnableRepo({ healthTimeoutSeconds: 90 }), web: runnableRepo() });
    const hints = makeServersHost(deps).viewHints();
    expect(hints.startBudgetMs?.('api')).toBe(90_000);
    expect(hints.startBudgetMs?.('web')).toBeUndefined();
    expect(hints.startBudgetMs?.('gone')).toBeUndefined();
  });

  it('sweeps through the injected liveness sweep', async () => {
    await makeServersHost(deps).sweep();
    expect(deps.sweepNow).toHaveBeenCalledOnce();
  });

  it('pins through the shared ops and delegates logs', () => {
    const host = makeServersHost(deps);
    host.setPinned('api', true);
    expect(store.db.prepare('SELECT repo FROM baseline_pins').all()).toEqual([{ repo: 'api' }]);
    host.openTicketLogs(3);
    host.openSharedLogs();
    host.openLogs();
    expect(deps.openTicketLogs).toHaveBeenCalledWith(3);
    expect(deps.openSharedLogs).toHaveBeenCalledOnce();
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
