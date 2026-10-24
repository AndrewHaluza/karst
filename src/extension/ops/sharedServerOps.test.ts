import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { listPinnedBaselines, pinBaseline } from '../../store/baselinePins.js';
import { manifest, runnableRepo } from '../../manifest/fixtures.js';
import type { Notify } from './notify.js';
import {
  idleShared,
  restartShared,
  setPinned,
  startShared,
  stopIdle,
  stopShared,
  type SharedServerOpsDeps,
} from './sharedServerOps.js';
import { listSharedServers } from '../../store/serverInventory.js';

const M = manifest({ api: runnableRepo(), web: runnableRepo(), db: runnableRepo() });

function addBaseline(store: Store, repo: string, status = 'running'): number {
  return Number(
    store.db
      .prepare("INSERT INTO servers (ticket_id, repo, host, port, pid, status) VALUES (NULL, ?, 'localhost', 3000, 1, ?)")
      .run(repo, status).lastInsertRowid,
  );
}

function depend(store: Store, repo: string, key: string, stage = 'impl'): number {
  const t = createTicket(store, { key, title: key, projectId: 1 });
  store.db.prepare('INSERT INTO baseline_refs (ticket_id, repo) VALUES (?, ?)').run(t.id, repo);
  store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
  return t.id;
}

describe('sharedServerOps', () => {
  let store: Store;
  let notify: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let deps: SharedServerOpsDeps;
  let confirm: Mock<SharedServerOpsDeps['confirm']>;
  let ensureBaseline: Mock<SharedServerOpsDeps['ensureBaseline']>;
  let stopServer: Mock<SharedServerOpsDeps['stopServer']>;
  let after: Mock<SharedServerOpsDeps['afterServerChange']>;

  beforeEach(() => {
    store = openStore(':memory:');
    notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) };
    confirm = vi.fn<SharedServerOpsDeps['confirm']>(async () => true);
    after = vi.fn<SharedServerOpsDeps['afterServerChange']>();
    ensureBaseline = vi.fn<SharedServerOpsDeps['ensureBaseline']>(async (s, _m, repo) => {
      s.db.prepare("DELETE FROM servers WHERE ticket_id IS NULL AND repo = ?").run(repo);
      addBaseline(s, repo, 'running');
    });
    stopServer = vi.fn<SharedServerOpsDeps['stopServer']>(async (s, id) => {
      s.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(id);
    });
    deps = {
      store,
      notify: notify as unknown as Notify,
      loadManifest: async () => M,
      ensureBaseline,
      stopServer,
      confirm,
      afterServerChange: after,
    };
  });
  afterEach(() => store.close());

  describe('startShared', () => {
    it('ensures the baseline, pins it, announces and repaints', async () => {
      await startShared(deps, 'api');
      expect(ensureBaseline).toHaveBeenCalledWith(store, M, 'api');
      expect(listPinnedBaselines(store).has('api')).toBe(true);
      expect(notify.info).toHaveBeenCalledWith('Started api and kept it running.');
      expect(after).toHaveBeenCalledOnce();
    });

    it('rejects an undeclared unit without starting anything', async () => {
      await expect(startShared(deps, 'ghost')).rejects.toThrow('not a service declared');
      expect(ensureBaseline).not.toHaveBeenCalled();
    });

    it('rejects when no manifest loads', async () => {
      await expect(startShared({ ...deps, loadManifest: async () => null }, 'api')).rejects.toThrow('No karst.yml');
    });

    it('does not pin and still repaints when the start fails', async () => {
      ensureBaseline.mockRejectedValueOnce(new Error('port busy'));
      await expect(startShared(deps, 'api')).rejects.toThrow('Failed to start api: port busy');
      expect(listPinnedBaselines(store).size).toBe(0);
      expect(after).toHaveBeenCalledOnce();
    });
  });

  describe('stopShared', () => {
    it('confirms naming live dependents (done ones with their reason), stops, and unpins', async () => {
      addBaseline(store, 'api');
      pinBaseline(store, 'api');
      depend(store, 'api', 'T-1');
      const done = depend(store, 'api', 'T-2', 'done');
      store.db.prepare("INSERT INTO servers (ticket_id, repo, status, kind) VALUES (?, 'web', 'running', 'service')").run(done);
      await stopShared(deps, 'api');
      const [message, label] = confirm.mock.calls[0] as [string, string];
      expect(message).toContain('2 live ticket(s) depend on it: T-1, T-2 (done, still running).');
      expect(label).toBe('Stop service');
      expect(stopServer).toHaveBeenCalledOnce();
      expect(listPinnedBaselines(store).size).toBe(0);
      expect(notify.info).toHaveBeenCalledWith('Stopped api.');
    });

    it('says so when nothing depends on it', async () => {
      addBaseline(store, 'api');
      await stopShared(deps, 'api');
      expect(confirm.mock.calls[0]![0]).toContain('No live ticket depends on it.');
    });

    it('does nothing when the user declines, and keeps the pin', async () => {
      addBaseline(store, 'api');
      pinBaseline(store, 'api');
      confirm.mockResolvedValueOnce(false);
      await stopShared(deps, 'api');
      expect(stopServer).not.toHaveBeenCalled();
      expect(listPinnedBaselines(store).has('api')).toBe(true);
    });

    it('rejects a row that vanished or already stopped', async () => {
      await expect(stopShared(deps, 'api')).rejects.toThrow('api is not running.');
      addBaseline(store, 'web', 'stopped');
      await expect(stopShared(deps, 'web')).rejects.toThrow('web is not running.');
      expect(confirm).not.toHaveBeenCalled();
    });

    it('reports a refused stop instead of claiming success, and keeps the pin', async () => {
      addBaseline(store, 'api');
      pinBaseline(store, 'api');
      stopServer.mockResolvedValueOnce(undefined);
      await expect(stopShared(deps, 'api')).rejects.toThrow('was not stopped');
      expect(listPinnedBaselines(store).has('api')).toBe(true);
      expect(after).toHaveBeenCalledOnce();
    });
  });

  describe('restartShared', () => {
    it('confirms, stops attributed, restarts, and leaves the pin as it was', async () => {
      addBaseline(store, 'api');
      depend(store, 'api', 'T-1');
      await restartShared(deps, 'api');
      expect(confirm.mock.calls[0]![0]).toContain('T-1');
      expect(confirm.mock.calls[0]![1]).toBe('Restart');
      expect(stopServer.mock.invocationCallOrder[0]!).toBeLessThan(ensureBaseline.mock.invocationCallOrder[0]!);
      expect(listPinnedBaselines(store).size).toBe(0);
      expect(notify.info).toHaveBeenCalledWith('Restarted api.');
    });

    it('keeps an existing pin across the restart', async () => {
      addBaseline(store, 'api');
      pinBaseline(store, 'api');
      await restartShared(deps, 'api');
      expect(listPinnedBaselines(store).has('api')).toBe(true);
    });

    it('rejects a stopped unit (Start is the verb) and a declined confirm is a no-op', async () => {
      addBaseline(store, 'api', 'stopped');
      await expect(restartShared(deps, 'api')).rejects.toThrow('Start it instead');
      addBaseline(store, 'web');
      confirm.mockResolvedValueOnce(false);
      await restartShared(deps, 'web');
      expect(stopServer).not.toHaveBeenCalled();
    });

    it('does not restart when the stop was refused', async () => {
      addBaseline(store, 'api');
      stopServer.mockResolvedValueOnce(undefined);
      await expect(restartShared(deps, 'api')).rejects.toThrow('was not stopped');
      expect(ensureBaseline).not.toHaveBeenCalled();
    });
  });

  describe('setPinned', () => {
    it('pins and unpins without touching the process', () => {
      setPinned(deps, 'api', true);
      expect(listPinnedBaselines(store).has('api')).toBe(true);
      setPinned(deps, 'api', false);
      expect(listPinnedBaselines(store).size).toBe(0);
      expect(stopServer).not.toHaveBeenCalled();
      expect(after).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopIdle', () => {
    it('selects running, dependent-free, unpinned rows only', () => {
      addBaseline(store, 'api');
      addBaseline(store, 'web');
      addBaseline(store, 'db');
      depend(store, 'api', 'T-1');
      pinBaseline(store, 'web');
      expect(idleShared(listSharedServers(store, M)).map((s) => s.repo)).toEqual(['db']);
    });

    it('treats a done ticket with nothing running as no dependent', () => {
      addBaseline(store, 'api');
      depend(store, 'api', 'T-1', 'done');
      expect(idleShared(listSharedServers(store, M)).map((s) => s.repo)).toEqual(['api']);
    });

    it('does one confirm naming them, stops each, reports the count', async () => {
      addBaseline(store, 'api');
      addBaseline(store, 'db');
      const result = await stopIdle(deps);
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0]![0]).toContain('api, db');
      expect(result.stopped.sort()).toEqual(['api', 'db']);
      expect(notify.info).toHaveBeenCalledWith('Stopped 2 idle shared service(s): api, db.');
      expect(after).toHaveBeenCalledOnce();
    });

    it('names every failure and still stops the rest', async () => {
      addBaseline(store, 'api');
      addBaseline(store, 'db');
      stopServer.mockImplementationOnce(async () => {
        throw new Error('EPERM');
      });
      await expect(stopIdle(deps)).rejects.toThrow('Stopped 1 of 2. Not stopped: api (EPERM)');
      expect(stopServer).toHaveBeenCalledTimes(2);
    });

    it('does nothing and says so when nothing is idle', async () => {
      addBaseline(store, 'api');
      pinBaseline(store, 'api');
      const result = await stopIdle(deps);
      expect(confirm).not.toHaveBeenCalled();
      expect(result).toEqual({ stopped: [], failed: [] });
      expect(notify.info).toHaveBeenCalledWith('No idle shared services to stop.');
    });

    it('stops nothing when the user declines', async () => {
      addBaseline(store, 'api');
      confirm.mockResolvedValueOnce(false);
      await stopIdle(deps);
      expect(stopServer).not.toHaveBeenCalled();
    });
  });
});
