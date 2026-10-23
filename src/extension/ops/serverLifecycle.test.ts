import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import {
  maybeStopServersOnDone,
  type ServerLifecycleDeps,
} from './serverLifecycle.js';
import type { Manifest } from '../../manifest/types.js';
import { stopTicketServers } from '../../runtime/supervisor.js';

let store: Store;

function seedTicket(id = 408, title: string | null = 'Usage limits', key: string | null = 'T408'): void {
  store.db
    .prepare(
      "INSERT INTO tickets (id, key, title, stage_current, agent_state) VALUES (?, ?, ?, 'scope', 'none')",
    )
    .run(id, key, title);
}

function insertRunningService(ticketId: number, repo: string, pid = 1000): void {
  store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, status, kind, pid, host, port) VALUES (?, ?, 'running', 'service', ?, '127.0.0.1', 3000)",
    )
    .run(ticketId, repo, pid);
}

function insertStoppedService(ticketId: number, repo: string): void {
  store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, status, kind, pid, host, port) VALUES (?, ?, 'stopped', 'service', NULL, '127.0.0.1', 3000)",
    )
    .run(ticketId, repo);
}

function insertRunningAgent(ticketId: number): void {
  store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, status, kind, pid, host, port) VALUES (?, 'agent', 'running', 'agent', 2000, '127.0.0.1', 4000)",
    )
    .run(ticketId);
}

function makeDeps(overrides: Partial<ServerLifecycleDeps> = {}): {
  deps: ServerLifecycleDeps;
  notify: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    infoActions: ReturnType<typeof vi.fn>;
  };
  stopServers: ReturnType<typeof vi.fn>;
  writeManifest: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const notify = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn().mockResolvedValue(undefined),
    infoActions: vi.fn().mockResolvedValue(undefined),
  };
  const stopServers = overrides.stopServers ? vi.fn(overrides.stopServers) : vi.fn().mockResolvedValue(undefined);
  const writeManifest = overrides.writeManifest ? vi.fn(overrides.writeManifest) : vi.fn();
  const logError = overrides.logError ? vi.fn(overrides.logError) : vi.fn();

  const deps: ServerLifecycleDeps = {
    store,
    manifest: () => ({
      host: '127.0.0.1',
      portRange: [3000, 3999],
      baselineBranch: 'main',
      repositories: {
        web: { repoPath: '.', baselineBranch: 'main', hasMigrations: false },
      },
    }),
    ...overrides,
    stopServers,
    notify,
    writeManifest,
    manifestPath: overrides.manifestPath ?? (() => '/path/to/karst.yml'),
    logError,
  };

  return {
    deps,
    notify,
    stopServers,
    writeManifest,
    logError,
  };
}

describe('serverLifecycle — maybeStopServersOnDone', () => {
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('no rows -> no prompt and no stop (None -> no-op)', async () => {
    seedTicket(408, 'Usage limits');
    const { deps, notify, stopServers } = makeDeps();

    await maybeStopServersOnDone(deps, 408);

    expect(notify.infoActions).not.toHaveBeenCalled();
    expect(notify.info).not.toHaveBeenCalled();
    expect(stopServers).not.toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBeNull();
  });

  it('only stopped servers or agent servers -> no prompt and no stop', async () => {
    seedTicket(408, 'Usage limits');
    insertStoppedService(408, 'web');
    insertRunningAgent(408);
    const { deps, notify, stopServers } = makeDeps();

    await maybeStopServersOnDone(deps, 408);

    expect(notify.infoActions).not.toHaveBeenCalled();
    expect(stopServers).not.toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBeNull();
  });

  it('off -> no stop and silent', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    insertRunningService(408, 'api');
    const { deps, notify, stopServers } = makeDeps({
      manifest: () => ({ stopServersOnDone: 'off' } as Manifest),
    });

    await maybeStopServersOnDone(deps, 408);

    expect(stopServers).not.toHaveBeenCalled();
    expect(notify.infoActions).not.toHaveBeenCalled();
    expect(notify.info).not.toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBe('off');

    // Re-observation is a no-op
    await maybeStopServersOnDone(deps, 408);
    expect(stopServers).not.toHaveBeenCalled();
  });

  it('auto -> stops and announces "Stopped N servers for T408 (done)"', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    insertRunningService(408, 'api');
    const afterServerChange = vi.fn();
    const { deps, notify, stopServers } = makeDeps({
      manifest: () => ({ stopServersOnDone: 'auto' } as Manifest),
      afterServerChange,
    });

    await maybeStopServersOnDone(deps, 408);

    expect(stopServers).toHaveBeenCalledWith(store, 408);
    expect(afterServerChange).toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('Stopped 2 servers for T408 (done)');
    expect(getTicket(store, 408).serversOnDone).toBe('auto');

    // Re-observation does not stop or announce again
    stopServers.mockClear();
    notify.info.mockClear();
    await maybeStopServersOnDone(deps, 408);
    expect(stopServers).not.toHaveBeenCalled();
    expect(notify.info).not.toHaveBeenCalled();
  });

  it('auto -> handles singular server count', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify, stopServers } = makeDeps({
      manifest: () => ({ stopServersOnDone: 'auto' } as Manifest),
    });

    await maybeStopServersOnDone(deps, 408);

    expect(stopServers).toHaveBeenCalledWith(store, 408);
    expect(notify.info).toHaveBeenCalledWith('Stopped 1 server for T408 (done)');
  });

  it('ask (default) -> shows ONE prompt with three actions; dismissal records asked and does not re-prompt', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    insertRunningService(408, 'api');
    const { deps, notify, stopServers } = makeDeps({
      manifest: () => ({} as Manifest), // absent = ask
    });
    // Dismissed by user:
    notify.infoActions.mockResolvedValueOnce(undefined);

    await maybeStopServersOnDone(deps, 408);

    expect(notify.infoActions).toHaveBeenCalledWith(
      'T408 · Usage limits is done. Its 2 servers are still running.',
      ['Stop servers', 'Keep running', 'Always stop'],
    );
    expect(stopServers).not.toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBe('asked');

    // Re-observation does not prompt again
    notify.infoActions.mockClear();
    await maybeStopServersOnDone(deps, 408);
    expect(notify.infoActions).not.toHaveBeenCalled();
  });

  it('ask -> singular server copy', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify } = makeDeps();
    notify.infoActions.mockResolvedValueOnce(undefined);

    await maybeStopServersOnDone(deps, 408);

    expect(notify.infoActions).toHaveBeenCalledWith(
      'T408 · Usage limits is done. Its 1 server is still running.',
      ['Stop servers', 'Keep running', 'Always stop'],
    );
  });

  it('ask -> "Keep running" records kept and leaves servers running', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify, stopServers } = makeDeps();
    notify.infoActions.mockResolvedValueOnce('Keep running');

    await maybeStopServersOnDone(deps, 408);

    expect(stopServers).not.toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBe('kept');

    // Re-observation does not prompt
    notify.infoActions.mockClear();
    await maybeStopServersOnDone(deps, 408);
    expect(notify.infoActions).not.toHaveBeenCalled();
  });

  it('ask -> "Stop servers" stops servers and records stopped', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const afterServerChange = vi.fn();
    const { deps, notify, stopServers } = makeDeps({ afterServerChange });
    notify.infoActions.mockResolvedValueOnce('Stop servers');

    await maybeStopServersOnDone(deps, 408);

    expect(stopServers).toHaveBeenCalledWith(store, 408);
    expect(afterServerChange).toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBe('stopped');

    // Re-observation does not prompt or stop again
    stopServers.mockClear();
    notify.infoActions.mockClear();
    await maybeStopServersOnDone(deps, 408);
    expect(stopServers).not.toHaveBeenCalled();
    expect(notify.infoActions).not.toHaveBeenCalled();
  });

  it('ask -> "Always stop" writes stopServersOnDone: auto, announces change, and stops now', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const afterServerChange = vi.fn();
    const { deps, notify, stopServers, writeManifest } = makeDeps({ afterServerChange });
    notify.infoActions.mockResolvedValueOnce('Always stop');

    await maybeStopServersOnDone(deps, 408);

    expect(writeManifest).toHaveBeenCalledWith(
      '/path/to/karst.yml',
      expect.objectContaining({ stopServersOnDone: 'auto' }),
    );
    expect(notify.info).toHaveBeenCalledWith('Set stopServersOnDone to auto in karst.yml.');
    expect(stopServers).toHaveBeenCalledWith(store, 408);
    expect(afterServerChange).toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBe('stopped');
  });

  it('manifest write failure still stops servers and reports error', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify, stopServers, writeManifest, logError } = makeDeps({
      writeManifest: () => {
        throw new Error('disk full');
      },
    });
    notify.infoActions.mockResolvedValueOnce('Always stop');

    await maybeStopServersOnDone(deps, 408);

    expect(writeManifest).toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('writing stopServersOnDone: auto to manifest failed'),
      expect.any(Error),
    );
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(stopServers).toHaveBeenCalledWith(store, 408);
    expect(getTicket(store, 408).serversOnDone).toBe('stopped');
  });

  it('manifest undefined reports error and still stops servers without calling writeManifest', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify, stopServers, writeManifest, logError } = makeDeps({
      manifest: () => undefined,
    });
    notify.infoActions.mockResolvedValueOnce('Always stop');

    await maybeStopServersOnDone(deps, 408);

    expect(writeManifest).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('writing stopServersOnDone: auto to manifest failed'),
      expect.any(Error),
    );
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('manifest is not loaded'));
    expect(stopServers).toHaveBeenCalledWith(store, 408);
    expect(getTicket(store, 408).serversOnDone).toBe('stopped');
  });

  it('sandbox seam used: stopServers receives store and ticketId', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const sandboxStop = vi.fn().mockResolvedValue(undefined);
    const stopServers = (s: Store, id: number) => sandboxStop(s, id);
    const { deps, notify } = makeDeps({ stopServers });
    notify.infoActions.mockResolvedValueOnce('Stop servers');

    await maybeStopServersOnDone(deps, 408);

    expect(sandboxStop).toHaveBeenCalledWith(store, 408);
  });

  it('auto -> stop failure logs and notifies error and does not announce success', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const stopError = new Error('EPERM kill denied');
    const { deps, notify, logError } = makeDeps({
      manifest: () => ({ stopServersOnDone: 'auto' } as Manifest),
      stopServers: () => {
        throw stopError;
      },
    });

    await maybeStopServersOnDone(deps, 408);

    expect(logError).toHaveBeenCalledWith(
      'karst: stopping servers for ticket 408 failed',
      stopError,
    );
    expect(notify.error).toHaveBeenCalledWith(
      'Failed to stop servers for ticket T408: EPERM kill denied',
    );
    expect(notify.info).not.toHaveBeenCalled();
    expect(getTicket(store, 408).serversOnDone).toBe('auto');
  });

  it('ask -> untitled ticket uses tId only', async () => {
    seedTicket(408, null);
    insertRunningService(408, 'web');
    const { deps, notify } = makeDeps();
    notify.infoActions.mockResolvedValueOnce(undefined);

    await maybeStopServersOnDone(deps, 408);

    expect(notify.infoActions).toHaveBeenCalledWith(
      'T408 is done. Its 1 server is still running.',
      ['Stop servers', 'Keep running', 'Always stop'],
    );
  });

  it('ask (default) -> setting defaults to ask when manifest is undefined or stopServersOnDone is absent', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify } = makeDeps({
      manifest: () => undefined,
    });
    notify.infoActions.mockResolvedValueOnce(undefined);

    await maybeStopServersOnDone(deps, 408);

    expect(notify.infoActions).toHaveBeenCalled();
  });

  it('stop failure without logError still notifies error with non-Error message', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify } = makeDeps({
      logError: undefined,
      stopServers: () => {
        throw 'string error';
      },
    });
    notify.infoActions.mockResolvedValueOnce('Stop servers');

    await maybeStopServersOnDone(deps, 408);

    expect(notify.error).toHaveBeenCalledWith('Failed to stop servers for ticket T408: string error');
  });

  it('write failure without logError still notifies error and stops', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const { deps, notify, stopServers } = makeDeps({
      logError: undefined,
      writeManifest: () => {
        throw 'fail';
      },
    });
    notify.infoActions.mockResolvedValueOnce('Always stop');

    await maybeStopServersOnDone(deps, 408);

    expect(notify.error).toHaveBeenCalledWith('Failed to update karst.yml: fail');
    expect(stopServers).toHaveBeenCalledWith(store, 408);
  });

  it('stop failure reported, never swallowed', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    const stopError = new Error('EPERM kill denied');
    const { deps, notify, logError } = makeDeps({
      stopServers: () => Promise.reject(stopError),
    });
    notify.infoActions.mockResolvedValueOnce('Stop servers');

    await maybeStopServersOnDone(deps, 408);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('stopping servers for ticket 408 failed'),
      stopError,
    );
    expect(notify.error).toHaveBeenCalledWith(expect.stringContaining('EPERM kill denied'));
  });

  it('no server row deletion, no worktree removal; rows read offline and restartable', async () => {
    seedTicket(408, 'Usage limits');
    insertRunningService(408, 'web');
    insertRunningService(408, 'api');

    // Use the real supervisor stopTicketServers as stopServers seam
    const { deps, notify } = makeDeps({
      stopServers: stopTicketServers,
    });
    notify.infoActions.mockResolvedValueOnce('Stop servers');

    await maybeStopServersOnDone(deps, 408);

    // Rows must NOT be deleted:
    const rows = store.db
      .prepare('SELECT id, status, pid FROM servers WHERE ticket_id = ?')
      .all(408) as { id: number; status: string; pid: number | null }[];

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('stopped');
      expect(r.pid).toBeNull();
    }
  });
});
