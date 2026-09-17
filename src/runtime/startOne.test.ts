import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { startResolvedService } from './startService.js';
import { stopServer } from './supervisor.js';
import { startTicketService, StartServiceError } from './startOne.js';
import { MissingAllocationError } from '../resolver/recordedAllocator.js';
import { manifest, repo, stack } from '../manifest/fixtures.js';

vi.mock('./startService.js', () => ({ startResolvedService: vi.fn() }));
vi.mock('./supervisor.js', () => ({ stopServer: vi.fn() }));

const startResolvedMock = vi.mocked(startResolvedService);
const stopServerMock = vi.mocked(stopServer);

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

  it('starts only repo B and leaves repo A running untouched', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/backend', '/wt/backend');
    addWorktree(1, '/repo/frontend', '/wt/frontend');
    addAllocation(1, 'backend', 'http', 4100);
    addAllocation(1, 'frontend', 'http', 4200);
    addServer(1, 10, 'backend', 4100, 1111, 'running');

    const rec = await startTicketService(store, m, 1, 'frontend');

    expect(startResolvedMock).toHaveBeenCalledOnce();
    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.name).toBe('frontend');
    expect(args.cwd).toBe('/wt/frontend');
    expect(rec.port).toBe(4200);
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

    const rec = await startTicketService(store, m, 1, 'frontend');

    expect(stopServerMock).toHaveBeenCalledOnce();
    expect(stopServerMock).toHaveBeenCalledWith(store, 20);
    expect(rec.port).toBe(4200);
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

  it('propagates MissingAllocationError when the target has no recorded allocation', async () => {
    const m = manifest(stack());
    addWorktree(1, '/repo/frontend', '/wt/frontend');

    const err = await startTicketService(store, m, 1, 'frontend').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingAllocationError);
    expect((err as Error).name).toBe('MissingAllocationError');
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

    const rec = await startTicketService(store, m, 1, 'frontend');

    expect(rec.port).toBe(4200);
    const args = startResolvedMock.mock.calls[0]![0];
    expect(args.resolved.services['backend']!.mode).toBe('baseline');
  });
});
