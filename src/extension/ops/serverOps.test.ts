import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import {
  stopServerRow,
  startServerRow,
  restartServerRow,
  openServerRow,
  copyServerUrlRow,
  type ServerOpsDeps,
} from './serverOps.js';
import type { Notify } from './notify.js';
import {
  startTicketService,
  StartServiceError,
  type StartTicketServiceResult,
} from '../../runtime/startOne.js';
import { stopServer } from '../../runtime/supervisor.js';
import { MissingAllocationError } from '../../resolver/recordedAllocator.js';
import { PortRangeExhaustedError } from '../../resolver/allocator.js';
import { manifest, stack } from '../../manifest/fixtures.js';

/** A recorded-path result: the target kept its port and nothing was rewired. */
function recordedResult(): StartTicketServiceResult {
  return { record: {} as never, newPorts: {}, restartedDependents: [] };
}

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
    startTicketServiceMock.mockResolvedValue(recordedResult());
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

  it('openServerRow opens a running row externally', () => {
    addServer(1, 7, 'backend');
    const deps = makeDeps({ store });
    openServerRow(deps, 1);
    expect(deps.openExternal).toHaveBeenCalledWith('http://localhost:5000');
    expect(deps.notify.warn).not.toHaveBeenCalled();
  });

  it('openServerRow warns when the server is no longer running', () => {
    const deps = makeDeps({ store });
    openServerRow(deps, 999);
    expect(deps.notify.warn).toHaveBeenCalledWith('That server is no longer running.');
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('copyServerUrlRow copies a running row url', () => {
    addServer(1, 7, 'backend');
    const deps = makeDeps({ store });
    copyServerUrlRow(deps, 1);
    expect(deps.copyText).toHaveBeenCalledWith('http://localhost:5000');
    expect(deps.notify.warn).not.toHaveBeenCalled();
  });

  it('copyServerUrlRow warns when the server is no longer running', () => {
    const deps = makeDeps({ store });
    copyServerUrlRow(deps, 999);
    expect(deps.notify.warn).toHaveBeenCalledWith('That server is no longer running.');
    expect(deps.copyText).not.toHaveBeenCalled();
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
    expect(stopServerMock).not.toHaveBeenCalled();
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
    await expect(startServerRow(deps, 1)).rejects.toThrow(/^typed failure$/);
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
      return recordedResult();
    });
    const deps = makeDeps({ store });
    await restartServerRow(deps, 1);
    expect(order).toEqual(['stop', 'start']);
    expect(deps.notify.info).toHaveBeenCalledWith('Restarted backend.');
  });

  it('startServerRow names the new port and the dependents it restarted', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockResolvedValue({
      record: {} as never,
      newPorts: { http: 6012 },
      restartedDependents: ['api', 'worker'],
    });
    const deps = makeDeps({ store });
    await startServerRow(deps, 1);
    expect(deps.notify.info).toHaveBeenCalledWith(
      'Started backend on :6012 (new port); restarted api, worker to rewire.',
    );
  });

  it('startServerRow names the new port with no dependents to rewire', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockResolvedValue({
      record: {} as never,
      newPorts: { http: 6012 },
      restartedDependents: [],
    });
    const deps = makeDeps({ store });
    await startServerRow(deps, 1);
    expect(deps.notify.info).toHaveBeenCalledWith('Started backend on :6012 (new port).');
  });

  it('startServerRow names every newly allocated port', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockResolvedValue({
      record: {} as never,
      newPorts: { http: 6012, debug: 9229 },
      restartedDependents: [],
    });
    const deps = makeDeps({ store });
    await startServerRow(deps, 1);
    expect(deps.notify.info).toHaveBeenCalledWith('Started backend on :6012, :9229 (new ports).');
  });

  it('startServerRow surfaces a port-range-exhausted error as a user-facing message', async () => {
    addServer(1, 7, 'backend');
    startTicketServiceMock.mockRejectedValue(
      new PortRangeExhaustedError([4000, 4099], 1, 'backend'),
    );
    const deps = makeDeps({ store });
    await expect(startServerRow(deps, 1)).rejects.toThrow(
      'Cannot start backend: no free contiguous block of 1 port(s) in range [4000, 4099] for service "backend". Free a port or widen the range, then try again.',
    );
    expect(deps.afterServerChange).toHaveBeenCalledTimes(1);
  });
});
