import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { startResolvedService } from './startService.js';
import { stopServer } from './supervisor.js';
import { startTicketService, StartServiceError } from './startOne.js';
import { PortRangeExhaustedError } from '../resolver/allocator.js';
import {
  dependsOn,
  httpSlot,
  manifest,
  repo,
  runnableRepo,
  stack,
  svc,
} from '../manifest/fixtures.js';

vi.mock('./startService.js', () => ({ startResolvedService: vi.fn() }));
vi.mock('./supervisor.js', () => ({ stopServer: vi.fn() }));

const startResolvedMock = vi.mocked(startResolvedService);
const stopServerMock = vi.mocked(stopServer);

/** Live-listener probe stub: this machine owns no port in the fixtures' ranges. */
const noBusy = async (): Promise<Set<number>> => new Set<number>();

describe('startTicketService', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
    store.db.prepare('INSERT INTO tickets (id, key, title) VALUES (1, ?, ?)').run('K-1', 'test');
    startResolvedMock.mockReset();
    stopServerMock.mockReset();
    startResolvedMock.mockImplementation(async (args) => {
      const ports = args.resolved.services[args.name]!.ports;
      return {
        id: 99,
        ticketId: args.ticketId,
        service: args.name,
        host: args.manifest.host,
        port: ports['http']!,
        pid: 4242,
        status: 'running',
        logPath: `/logs/${args.name}.log`,
        container: null,
      };
    });
  });

  afterEach(() => store.close());

  function addWorktree(ticketId: number, repoPath: string, path: string): void {
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, repoPath, path, 'karst/x', 'develop');
  }

  function addAllocation(ticketId: number, repoName: string, portName: string, port: number): void {
    store.db
      .prepare('INSERT INTO port_allocations (ticket_id, repo, port_name, port) VALUES (?, ?, ?, ?)')
      .run(ticketId, repoName, portName, port);
  }

  function addServer(
    ticketId: number,
    id: number,
    repoName: string,
    port: number,
    pid: number,
    status: string,
  ): void {
    store.db
      .prepare(
        "INSERT INTO servers (id, ticket_id, repo, host, port, pid, status, log_path, cwd) VALUES (?, ?, ?, 'localhost', ?, ?, ?, ?, ?)",
      )
      .run(id, ticketId, repoName, port, pid, status, `/logs/${repoName}.log`, `/wt/${repoName}`);
  }

  function allocationOf(repoName: string, portName: string): number | undefined {
    return (
      store.db
        .prepare('SELECT port FROM port_allocations WHERE ticket_id = 1 AND repo = ? AND port_name = ?')
        .get(repoName, portName) as { port: number } | undefined
    )?.port;
  }

  function calledNames(): string[] {
    return startResolvedMock.mock.calls.map((c) => c[0].name);
  }

  it('starts only repo B and leaves repo A running untouched', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'backend', 'http', 4100);
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 10, 'backend', 4100, 1111, 'running');

    const { record } = await startTicketService(store, m, 1, 'frontend');

    expect(startResolvedMock).toHaveBeenCalledOnce();
    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.name).toBe('frontend');
    expect(args.cwd).toBe('/wt/frontend');
    expect(record.port).toBe(4200);
    expect(stopServerMock).not.toHaveBeenCalled();

    const aRow = store.db.prepare('SELECT status, pid FROM servers WHERE id = 10').get() as {
      status: string;
      pid: number;
    };
    expect(aRow.status).toBe('running');
    expect(aRow.pid).toBe(1111);
  });

  it('stops the existing running row once before restarting on the same port', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'backend', 'http', 4100);
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 20, 'frontend', 4200, 2222, 'running');

    const { record } = await startTicketService(store, m, 1, 'frontend');

    expect(stopServerMock).toHaveBeenCalledOnce();
    expect(stopServerMock).toHaveBeenCalledWith(store, 20);
    expect(record.port).toBe(4200);
  });

  it('rejects an unknown repository name', async () => {
    const m = manifest(stack());

    const err = await startTicketService(store, m, 1, 'ghost').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartServiceError);
    expect((err as Error).message).toContain('no longer in the manifest');
  });

  it('rejects a repository that declares no service', async () => {
    const m = manifest({ docs: repo() });
    addWorktree(1, '/repo', '/wt/docs');

    const err = await startTicketService(store, m, 1, 'docs').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartServiceError);
    expect((err as Error).message).toContain('declares no service');
  });

  it('rejects a runnable repository with no worktree row', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');

    const err = await startTicketService(store, m, 1, 'frontend').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartServiceError);
    expect((err as Error).message).toContain('no worktree for this ticket');
  });

  it('recovers a missing target allocation: records a new row and starts the target', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/frontend', '/wt/frontend');

    const result = await startTicketService(store, m, 1, 'frontend', { probeBusyPorts: noBusy });

    expect(calledNames()).toEqual(['frontend']);
    expect(result.record.port).toBe(4000); // lowest free in the range
    expect(result.newPorts).toEqual({ http: 4000 });
    expect(result.restartedDependents).toEqual([]);
    expect(allocationOf('frontend', 'http')).toBe(4000);
    // The unrecorded, stopped dependency the target needs is allocated too.
    expect(allocationOf('backend', 'http')).toBe(4001);
  });

  it('leaves a declared-baseline dependency on its default port during recovery', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    // The ticket already resolved backend as a shared baseline: it runs on its
    // default port, so recovery must NOT draw an alt port for it.
    store.db.prepare('INSERT INTO baseline_refs (ticket_id, repo) VALUES (?, ?)').run(1, 'backend');

    const result = await startTicketService(store, m, 1, 'frontend', { probeBusyPorts: noBusy });

    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.resolved.services['backend']!.mode).toBe('baseline');
    expect(args.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:3000');
    expect(allocationOf('backend', 'http')).toBeUndefined();
    expect(result.newPorts).toEqual({ http: 4000 });
  });

  it('rewires a running dependent that has no recorded allocation, keeping its live port', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    // frontend is running but its allocation was wiped.
    addServer(1, 30, 'frontend', 4200, 3333, 'running');

    const result = await startTicketService(store, m, 1, 'backend', { probeBusyPorts: noBusy });

    expect(calledNames()).toEqual(['backend', 'frontend']);
    expect(result.restartedDependents).toEqual(['frontend']);
    const feArgs = startResolvedMock.mock.calls[1]![0];
    expect(feArgs.resolved.services['frontend']!.ports.http).toBe(4200); // its LIVE port
    expect(feArgs.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:4000');
    expect(allocationOf('frontend', 'http')).toBe(4200);
    expect(stopServerMock).toHaveBeenCalledWith(store, 30);
  });

  it('names a running dependency live port in the target env', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    // backend (the target's dependency) is running but its allocation was wiped.
    addServer(1, 10, 'backend', 4100, 1111, 'running');

    const result = await startTicketService(store, m, 1, 'frontend', { probeBusyPorts: noBusy });

    expect(calledNames()).toEqual(['frontend']);
    expect(result.restartedDependents).toEqual([]);
    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:4100');
    expect(allocationOf('backend', 'http')).toBe(4100);
    expect(result.newPorts).toEqual({ http: 4000 });
  });

  it('restarts a running dependent with the target new port in its env', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 30, 'frontend', 4200, 3333, 'running');

    const result = await startTicketService(store, m, 1, 'backend', { probeBusyPorts: noBusy });

    expect(result.newPorts).toEqual({ http: 4000 });
    expect(result.restartedDependents).toEqual(['frontend']);
    expect(calledNames()).toEqual(['backend', 'frontend']);
    const feArgs = startResolvedMock.mock.calls[1]![0];
    expect(feArgs.cwd).toBe('/wt/frontend');
    expect(feArgs.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:4000');
    expect(stopServerMock).toHaveBeenCalledWith(store, 30);
  });

  it('leaves a stopped dependent untouched', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'frontend', 'http', 4200);
    // frontend is recorded but has no running row.

    const result = await startTicketService(store, m, 1, 'backend', { probeBusyPorts: noBusy });

    expect(result.restartedDependents).toEqual([]);
    expect(calledNames()).toEqual(['backend']);
    expect(stopServerMock).not.toHaveBeenCalled();
  });

  it('existing allocation path: no port moves and no dependent is restarted', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'backend', 'http', 4100);
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 30, 'frontend', 4200, 3333, 'running');

    const result = await startTicketService(store, m, 1, 'backend');

    expect(result.newPorts).toEqual({});
    expect(result.restartedDependents).toEqual([]);
    expect(result.record.port).toBe(4100);
    expect(calledNames()).toEqual(['backend']);
    expect(stopServerMock).not.toHaveBeenCalled();
    expect(allocationOf('frontend', 'http')).toBe(4200);
  });

  it('fails with a port-range error and records nothing when the range is exhausted', async () => {
    const m = manifest(stack(), { portRange: [5000, 4000] }); // inverted → no free block
    addWorktree(1, '/repo/frontend', '/wt/frontend');

    const err = await startTicketService(store, m, 1, 'frontend', {
      probeBusyPorts: noBusy,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PortRangeExhaustedError);
    expect(startResolvedMock).not.toHaveBeenCalled();
    const n = store.db
      .prepare('SELECT COUNT(*) AS n FROM port_allocations WHERE ticket_id = 1')
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('restarts only the running dependents that consume a moved port', async () => {
    const m = manifest({
      contracts: runnableRepo({ ports: [httpSlot(6000)] }, { repoPath: '/repo/contracts' }),
      backend: runnableRepo(
        {
          ports: [httpSlot(3000)],
          dependsOn: [
            dependsOn('contracts', 'http', [
              { env: 'CONTRACTS_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/backend' },
      ),
      frontend: runnableRepo(
        {
          ports: [httpSlot(5173)],
          dependsOn: [
            dependsOn('backend', 'http', [
              { env: 'VITE_API_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/frontend' },
      ),
    });
    addWorktree(1, '/repo/contracts', '/wt/contracts');
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'backend', 'http', 4100);
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 40, 'backend', 4100, 4444, 'running');
    addServer(1, 41, 'frontend', 4200, 5555, 'running');

    const result = await startTicketService(store, m, 1, 'contracts', {
      probeBusyPorts: noBusy,
    });

    // contracts moved; backend consumes it and restarts. frontend consumes
    // backend (4100, unchanged), so it is left alone.
    expect(calledNames()).toEqual(['contracts', 'backend']);
    expect(result.restartedDependents).toEqual(['backend']);
    const beArgs = startResolvedMock.mock.calls[1]![0];
    expect(beArgs.resolved.services['backend']!.env['CONTRACTS_URL']).toBe(
      'http://localhost:4000',
    );
  });

  it('keeps the target up and names the dependent when a dependent restart fails', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 30, 'frontend', 4200, 3333, 'running');
    startResolvedMock.mockImplementation(async (args) => {
      if (args.name === 'frontend') throw new Error('port is held by a stranger');
      const ports = args.resolved.services[args.name]!.ports;
      return {
        id: 99,
        ticketId: args.ticketId,
        service: args.name,
        host: args.manifest.host,
        port: ports['http']!,
        pid: 4242,
        status: 'running',
        logPath: `/logs/${args.name}.log`,
        container: null,
      };
    });

    const err = await startTicketService(store, m, 1, 'backend', {
      probeBusyPorts: noBusy,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StartServiceError);
    expect((err as Error).message).toContain('Started backend on the new port');
    expect((err as Error).message).toContain('frontend');
    expect((err as Error).message).toContain('port is held by a stranger');
    // the target itself did start; only the dependent restart failed.
    expect(calledNames()).toEqual(['backend', 'frontend']);
  });

  it('keeps rewiring the other dependents when one restart fails', async () => {
    const m = manifest({
      backend: runnableRepo({ ports: [httpSlot(3000)] }, { repoPath: '/repo/backend' }),
      api: runnableRepo(
        {
          ports: [httpSlot(8080)],
          dependsOn: [
            dependsOn('backend', 'http', [{ env: 'API_URL', template: 'http://{host}:{port}' }]),
          ],
        },
        { repoPath: '/repo/api' },
      ),
      worker: runnableRepo(
        {
          ports: [httpSlot(9090)],
          dependsOn: [
            dependsOn('backend', 'http', [
              { env: 'WORKER_API_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/worker' },
      ),
    });
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/api', '/wt/api');
    addWorktree(1, '/repo/worker', '/wt/worker');
    addAllocation(1, 'api', 'http', 4100);
    addAllocation(1, 'worker', 'http', 4200);
    addServer(1, 10, 'api', 4100, 1111, 'running');
    addServer(1, 20, 'worker', 4200, 2222, 'running');
    startResolvedMock.mockImplementation(async (args) => {
      if (args.name === 'api') throw new Error('api port held by a stranger');
      const ports = args.resolved.services[args.name]!.ports;
      return {
        id: 99,
        ticketId: args.ticketId,
        service: args.name,
        host: args.manifest.host,
        port: ports['http']!,
        pid: 4242,
        status: 'running',
        logPath: `/logs/${args.name}.log`,
        container: null,
      };
    });

    const err = await startTicketService(store, m, 1, 'backend', {
      probeBusyPorts: noBusy,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StartServiceError);
    expect((err as Error).message).toContain('api (api port held by a stranger)');
    // worker is still rewired even though api failed.
    expect(calledNames()).toEqual(['backend', 'api', 'worker']);
    const workerArgs = startResolvedMock.mock.calls.find((c) => c[0].name === 'worker')![0];
    expect(workerArgs.resolved.services['worker']!.env['WORKER_API_URL']).toBe(
      'http://localhost:4000',
    );
  });

  it('wires a restarted transitive dependent to its stopped peer allocated port, not a default', async () => {
    const m = manifest({
      contracts: runnableRepo({ ports: [httpSlot(6000)] }, { repoPath: '/repo/contracts' }),
      backend: runnableRepo(
        {
          ports: [httpSlot(3000)],
          dependsOn: [
            dependsOn('contracts', 'http', [
              { env: 'CONTRACTS_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/backend' },
      ),
      frontend: runnableRepo(
        {
          ports: [httpSlot(5173)],
          dependsOn: [
            dependsOn('backend', 'http', [
              { env: 'VITE_API_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/frontend' },
      ),
    });
    addWorktree(1, '/repo/contracts', '/wt/contracts');
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 41, 'frontend', 4200, 5555, 'running');

    const result = await startTicketService(store, m, 1, 'contracts', { probeBusyPorts: noBusy });

    expect(result.restartedDependents).toEqual(['frontend']);
    const feArgs = startResolvedMock.mock.calls.find((c) => c[0].name === 'frontend')![0];
    // backend is stopped and unrecorded but frontend binds its port, so it must
    // be allocated — never left at backend's default 3000.
    expect(feArgs.resolved.services['backend']!.ports.http).toBe(4001);
    expect(feArgs.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:4001');
  });

  it('does not allocate a port for an unrelated sibling service of the target repo', async () => {
    const m = manifest({
      mono: repo({
        repoPath: '/repo/mono',
        services: {
          api: svc({ ports: [httpSlot(3000)] }),
          web: svc({ ports: [httpSlot(5173)] }),
        },
      }),
    });
    addWorktree(1, '/repo/mono', '/wt/mono');

    const result = await startTicketService(store, m, 1, 'mono/api', { probeBusyPorts: noBusy });

    expect(result.newPorts).toEqual({ http: 4000 });
    expect(allocationOf('mono/api', 'http')).toBe(4000);
    // `web` is in the same (hot) repository but is neither started nor wired.
    expect(allocationOf('mono/web', 'http')).toBeUndefined();
  });

  it('starts the target even when unrelated siblings would exhaust the range', async () => {
    const m = manifest(
      {
        mono: repo({
          repoPath: '/repo/mono',
          services: {
            api: svc({ ports: [httpSlot(3000)] }),
            web: svc({ ports: [httpSlot(5173)] }),
          },
        }),
      },
      { portRange: [4000, 4000] }, // room for exactly one unit
    );
    addWorktree(1, '/repo/mono', '/wt/mono');

    const result = await startTicketService(store, m, 1, 'mono/api', { probeBusyPorts: noBusy });

    expect(result.newPorts).toEqual({ http: 4000 });
    expect(allocationOf('mono/web', 'http')).toBeUndefined();
  });

  it('keeps a running peer on its live port even when that port is already recorded elsewhere', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    // Another ticket already holds 4100; backend is nonetheless live on it.
    store.db
      .prepare('INSERT INTO tickets (id, key, title) VALUES (2, ?, ?)')
      .run('K-2', 'other');
    addAllocation(2, 'other', 'http', 4100);
    addServer(1, 10, 'backend', 4100, 1111, 'running');

    const result = await startTicketService(store, m, 1, 'frontend', { probeBusyPorts: noBusy });

    expect(calledNames()).toEqual(['frontend']);
    const args = startResolvedMock.mock.calls[0]![0];
    // backend is wired at its LIVE port, not re-drawn to a fresh one.
    expect(args.resolved.services['backend']!.ports.http).toBe(4100);
    expect(args.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:4100');
    expect(result.newPorts).toEqual({ http: 4000 });
  });

  it('releases the freshly drawn allocation when the target start fails', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    startResolvedMock.mockImplementation(async (args) => {
      if (args.name === 'frontend') throw new Error('fe refused to bind');
      const ports = args.resolved.services[args.name]!.ports;
      return {
        id: 99,
        ticketId: args.ticketId,
        service: args.name,
        host: args.manifest.host,
        port: ports['http']!,
        pid: 4242,
        status: 'running',
        logPath: `/logs/${args.name}.log`,
        container: null,
      };
    });

    const err = await startTicketService(store, m, 1, 'frontend', {
      probeBusyPorts: noBusy,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(allocationOf('frontend', 'http')).toBeUndefined();
    expect(allocationOf('backend', 'http')).toBeUndefined();
  });

  it('starts a recorded service when a sibling in the same repo has no record', async () => {
    const m = manifest({
      mono: repo({
        repoPath: '/repo/mono',
        services: {
          api: svc({ ports: [httpSlot(3000)] }),
          web: svc({ ports: [httpSlot(5173)] }), // added after the spin
        },
      }),
    });
    addWorktree(1, '/repo/mono', '/wt/mono');
    addAllocation(1, 'mono/api', 'http', 4100);

    const result = await startTicketService(store, m, 1, 'mono/api');

    expect(result.newPorts).toEqual({});
    expect(calledNames()).toEqual(['mono/api']);
    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.resolved.services['mono/api']!.ports.http).toBe(4100); // port never moved
    // the unrecorded sibling is hot but served its declared default, not a port.
    expect(allocationOf('mono/web', 'http')).toBeUndefined();
  });

  it('rewires another running consumer of a re-drawn shared dependency', async () => {
    const m = manifest({
      backend: runnableRepo({ ports: [httpSlot(3000)] }, { repoPath: '/repo/backend' }),
      api: runnableRepo(
        {
          ports: [httpSlot(8080)],
          dependsOn: [
            dependsOn('backend', 'http', [
              { env: 'API_BACKEND_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/api' },
      ),
      worker: runnableRepo(
        {
          ports: [httpSlot(9090)],
          dependsOn: [
            dependsOn('backend', 'http', [
              { env: 'WORKER_BACKEND_URL', template: 'http://{host}:{port}' },
            ]),
          ],
        },
        { repoPath: '/repo/worker' },
      ),
    });
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/api', '/wt/api');
    addWorktree(1, '/repo/worker', '/wt/worker');
    addAllocation(1, 'worker', 'http', 4200);
    addServer(1, 20, 'worker', 4200, 2222, 'running');
    // api is the target; backend is a shared stopped dependency of both api and
    // the already-running worker.

    const result = await startTicketService(store, m, 1, 'api', { probeBusyPorts: noBusy });

    expect(result.newPorts).toEqual({ http: 4000 });
    expect(result.restartedDependents).toEqual(['worker']);
    const workerArgs = startResolvedMock.mock.calls.find((c) => c[0].name === 'worker')![0];
    expect(workerArgs.resolved.services['api']!.env['API_BACKEND_URL']).toBe('http://localhost:4001');
    expect(workerArgs.resolved.services['worker']!.env['WORKER_BACKEND_URL']).toBe(
      'http://localhost:4001',
    );
  });

  it('never hands the target a port a running same-repo sibling is listening on', async () => {
    const m = manifest({
      mono: repo({
        repoPath: '/repo/mono',
        services: {
          api: svc({ ports: [httpSlot(3000)] }),
          web: svc({ ports: [httpSlot(5173)] }),
        },
      }),
    });
    addWorktree(1, '/repo/mono', '/wt/mono');
    // web is a sibling this recovery does not touch, live on the lowest free port.
    addServer(1, 30, 'mono/web', 4000, 3333, 'running');

    const result = await startTicketService(store, m, 1, 'mono/api', { probeBusyPorts: noBusy });

    expect(result.newPorts).toEqual({ http: 4001 }); // 4000 is taken by the live sibling
    expect(allocationOf('mono/api', 'http')).toBe(4001);
  });

  it('does not allocate a port for a peer the target depends on but does not bind', async () => {
    const m = manifest({
      backend: runnableRepo({ ports: [httpSlot(3000)] }, { repoPath: '/repo/backend' }),
      frontend: runnableRepo(
        { ports: [httpSlot(5173)], dependsOn: [dependsOn('backend', 'http', [])] },
        { repoPath: '/repo/frontend' },
      ),
    });
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');

    const result = await startTicketService(store, m, 1, 'frontend', { probeBusyPorts: noBusy });

    expect(result.newPorts).toEqual({ http: 4000 });
    expect(allocationOf('backend', 'http')).toBeUndefined();
  });

  it('resolves the whole hot set so a peer binds its allocated port, not its default', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'backend', 'http', 4100);
    addAllocation(1, 'frontend', 'http', 4200);

    await startTicketService(store, m, 1, 'frontend');

    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.resolved.services['frontend']!.env['VITE_API_URL']).toBe('http://localhost:4100');
    expect(args.resolved.services['backend']!.mode).toBe('hot');
  });

  it('starts the target even when a peer worktree has no recorded allocation', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    // backend's allocation was released; only the target is still recorded.
    addAllocation(1, 'frontend', 'http', 4200);

    const { record } = await startTicketService(store, m, 1, 'frontend');

    expect(record.port).toBe(4200);
    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.resolved.services['backend']!.mode).toBe('baseline');
  });
});
