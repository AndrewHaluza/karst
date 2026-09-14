import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';

import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { setStage } from '../../store/stages.js';
import { runBootSweeps, type BootSweepDeps } from './bootSweeps.js';

// Container removal really spawns `docker`; stub it so a retired row's cleanup
// is asserted without a docker daemon on the machine.
vi.mock('../../runtime/dockerContainer.js', () => ({
  removeContainer: vi.fn(),
  removeContainerAsync: vi.fn(async () => {}),
}));
import { removeContainer } from '../../runtime/dockerContainer.js';
const removeContainerMock = vi.mocked(removeContainer);

function seedServer(
  store: Store,
  ticketId: number,
  pid: number | null,
  status: 'running' | 'stopped',
  opts: { port?: number; container?: string | null } = {},
): number {
  const info = store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, container) VALUES (?, 'api', '127.0.0.1', ?, ?, ?, '/l', ?)",
    )
    .run(ticketId, opts.port ?? 8000, pid, status, opts.container ?? null);
  return Number(info.lastInsertRowid);
}

/** A port nothing is listening on, as of now. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A port something IS listening on, plus a disposer. */
function openPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => s.close(() => r())) });
    });
  });
}

describe('runBootSweeps boot reconcile', () => {
  let store: Store;
  let globalStorageRoot: string;
  let info: string[];
  let deps: BootSweepDeps;

  beforeEach(() => {
    store = openStore(':memory:');
    globalStorageRoot = mkdtempSync(join(tmpdir(), 'karst-boot-'));
    info = [];
    deps = {
      store,
      globalStorageRoot,
      info: (message) => info.push(message),
      debug: () => {},
      logError: () => {},
    };
    removeContainerMock.mockClear();
  });

  it('retires a running row whose pid is gone and whose port is closed, and reports it', async () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    const deadId = seedServer(store, id, 999999, 'running', { port: await closedPort() });

    await runBootSweeps(deps);

    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(deadId) as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('stopped');
    expect(row.pid).toBeNull();
    expect(info.some((m) => m.includes("'api'") && m.includes('marked offline'))).toBe(true);
  });

  it('leaves a daemonised service whose pid is gone but whose port is still bound', async () => {
    const listener = await openPort();
    try {
      const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
      const rowId = seedServer(store, id, 999999, 'running', { port: listener.port });

      await runBootSweeps(deps);

      // A launcher that exits 0 records its own (dead) pid while the process it
      // left behind keeps serving. A bound port proves the service is up, so the
      // row must not be reported dead and flipped offline.
      const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(rowId) as {
        status: string;
        pid: number | null;
      };
      expect(row.status).toBe('running');
      expect(row.pid).toBe(999999);
      expect(info.some((m) => m.includes('marked offline'))).toBe(false);
    } finally {
      await listener.close();
    }
  });

  it('leaves a live-pid server row alone', async () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    const liveId = seedServer(store, id, process.pid, 'running', { port: await closedPort() });

    await runBootSweeps(deps);

    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(liveId) as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('running');
    expect(row.pid).toBe(process.pid);
    expect(info.some((m) => m.includes('marked offline'))).toBe(false);
  });

  it('retires a dead agent-session row that records no host or port', async () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    // A graph session shares the `servers` table but is not a service: it has no
    // address to probe. Probing it would throw on the null port and take the
    // whole reconcile with it, so its dead pid must be retired without a probe.
    const inserted = store.db
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, kind) VALUES (?, 'graph', NULL, NULL, 999999, 'running', '/l', 'agent')",
      )
      .run(id);
    const rowId = Number(inserted.lastInsertRowid);

    await runBootSweeps(deps);

    const row = store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(rowId) as {
      status: string;
      pid: number | null;
    };
    expect(row.status).toBe('stopped');
    expect(row.pid).toBeNull();
  });

  it('removes the container of a row it retires', async () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    const deadId = seedServer(store, id, 999999, 'running', {
      port: await closedPort(),
      container: 'karst-x',
    });

    await runBootSweeps(deps);

    expect(removeContainerMock).toHaveBeenCalledWith('karst-x');
    const row = store.db.prepare('SELECT status FROM servers WHERE id = ?').get(deadId) as {
      status: string;
    };
    expect(row.status).toBe('stopped');
  });

  it('leaves a ship stage another live run owns running (another window mid-ship)', async () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    setStage(store, id, 'ship', { status: 'running', startedAt: '2026-07-16T10:00:01Z' });
    // The pid is THIS test process: a live run, exactly as another window's ship
    // appears. Boot must not rewrite the stage it owns to needs-you.
    store.db
      .prepare(
        "INSERT INTO ship_runs (ticket_id, attempt, status, started_at, pid) VALUES (?, 0, 'running', ?, ?)",
      )
      .run(id, '2026-07-16T10:00:01Z', process.pid);

    await runBootSweeps(deps);

    const ship = store.db
      .prepare("SELECT status FROM stages WHERE ticket_id = ? AND stage_key = 'ship'")
      .get(id) as { status: string };
    expect(ship.status).toBe('running');
  });

  it('re-derives a drifted stage_current', async () => {
    const id = createTicketFlow(store, { key: 'T', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' }); // impl running
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('scope', id);

    await runBootSweeps(deps);

    const row = store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(id) as {
      stage_current: string;
    };
    expect(row.stage_current).toBe('impl');
  });
});
