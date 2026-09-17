import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import {
  stopServerRow,
  startServerRow,
  restartServerRow,
  type ServerOpsDeps,
} from './serverOps.js';
import type { Notify } from './notify.js';
import { startTicketService, StartServiceError } from '../../runtime/startOne.js';
import { stopServer } from '../../runtime/supervisor.js';
import { MissingAllocationError } from '../../resolver/recordedAllocator.js';
import { manifest, stack } from '../../manifest/fixtures.js';

vi.mock('../../runtime/startOne.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/startOne.js')>();
  return { ...actual, startTicketService: vi.fn() };
});
vi.mock('../../runtime/supervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/supervisor.js')>();
  return { ...actual, stopServer: vi.fn() };
});

const startTicketServiceMock = vi.mocked(startTicketService);
const stopServerMock = vi.mocked(stopServer);

function makeNotify(): Notify {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeDeps(overrides: Partial<ServerOpsDeps> = {}): ServerOpsDeps {
  return {
    store: {} as ServerOpsDeps['store'],
    notify: makeNotify(),
    afterServerChange: vi.fn(),
    loadManifest: vi.fn().mockResolvedValue(manifest(stack())),
    openExternal: vi.fn(),
    copyText: vi.fn(),
    debug: vi.fn(),
    ...overrides,
  };
}

describe('serverOps', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
    startTicketServiceMock.mockReset();
    stopServerMock.mockReset();
    startTicketServiceMock.mockResolvedValue({} as never);
  });

  afterEach(() => store.close());

  function addServer(id: number, ticketId: number | null, repo: string): void {
    store.db
      .prepare(
        "INSERT INTO servers (id, ticket_id, repo, host, port, pid, status, log_path, cwd) VALUES (?, ?, ?, 'localhost', 5000, 1234, 'running', '/logs/x.log', '/wt/x')",
      )
      .run(id, ticketId, repo);
  }

  it('stopServerRow repaints once', async () => {
    const deps = makeDeps({ store });
    await stopServerRow(deps, 1);
    expect(deps.afterServerChange).toHaveBeenCalledTimes(1);
  });

  it('startServerRow on a missing row rejects and starts nothing', async () => {
    const deps = makeDeps({ store });
    await expect(startServerRow(deps, 999)).rejects.toThrow('no longer exists');
    expect(startTicketServiceMock).not.toHaveBeenCalled();
    expect(deps.afterServerChange).not.toHaveBeenCalled();
  });

  it('startServerRow on a baseline row rejects', async () => {
    addServer(1, null, 'backend');
    const deps = makeDeps({ store });
    await expect(startServerRow(deps, 1)).rejects.toThrow('Baseline services');
    expect(startTicketServiceMock).not.toHaveBeenCalled();
  });

  it('startServerRow returns silently when loadManifest resolves null', async () => {
    addServer(1, 7, 'backend');
    const deps = makeDeps({ store, loadManifest: vi.fn().mockResolvedValue(null) });
    await startServerRow(deps, 1);
    expect(deps.notify.error).not.toHaveBeenCalled();
    expect(deps.notify.info).not.toHaveBeenCalled();
    expect(startTicketServiceMock).not.toHaveBeenCalled();
  });

  it('startServerRow success reports "Started <repo>." and repaints', async () => {
    addServer(1, 7, 'backend');
    const deps = makeDeps({ store });
    await startServerRow(deps, 1);
    expect(startTicketServiceMock).toHaveBeenCalledWith(
      store,
      expect.anything(),
      7,
      'backend',
      { debug: deps.debug },
    );
    expect(deps.notify.info).toHaveBeenCalledWith('Started backend.');
    expect(deps.afterServerChange).toHaveBeenCalledTimes(1);
  });

  it('startServerRow rejects a MissingAllocationError with the re-spin reason and still repaints', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockRejectedValue(new MissingAllocationError('backend', ['http']));
    const deps = makeDeps({ store });
    await expect(startServerRow(deps, 1)).rejects.toThrow('Re-spin the ticket');
    expect(deps.afterServerChange).toHaveBeenCalledTimes(1);
  });

  it('startServerRow rejects with a StartServiceError message verbatim', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockRejectedValue(new StartServiceError('typed failure'));
    const deps = makeDeps({ store });
    await expect(startServerRow(deps, 1)).rejects.toThrow('typed failure');
  });

  it('startServerRow rejects an unknown error as "Failed to start"', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockRejectedValue(new Error('boom'));
    const deps = makeDeps({ store });
    await expect(startServerRow(deps, 1)).rejects.toThrow('Failed to start backend: boom');
  });

  it('restartServerRow stops before starting and reports "Restarted <repo>."', async () => {
    addServer(1, 7, 'backend');
    const order: string[] = [];
    stopServerMock.mockImplementation(async () => {
      order.push('stop');
    });
    startTicketServiceMock.mockImplementation(async () => {
      order.push('start');
      return {} as never;
    });
    const deps = makeDeps({ store });
    await restartServerRow(deps, 1);
    expect(order).toEqual(['stop', 'start']);
    expect(deps.notify.info).toHaveBeenCalledWith('Restarted backend.');
  });
});
