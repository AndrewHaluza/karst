import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { stopServersUnder, reapStaleServers, describeReap } from './worktreeServers.js';
import type { ProcessFacts, LiveCwd } from './serverIdentity.js';
import { removeContainer } from './dockerContainer.js';

// The container removal is a real `docker rm -f` spawn; stub it so the reap
// cases can assert WHICH container was removed without a docker daemon.
vi.mock('./dockerContainer.js', () => ({ removeContainer: vi.fn() }));
const removeContainerMock = vi.mocked(removeContainer);

/** A detached, long-lived process standing in for a dev server. */
function spawnIdle(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone; the kill is a signal, so death is not synchronous. */
async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every row inserted here is recorded as spawned at this instant. */
const FIXED_STARTED_AT = '2026-08-03T07:00:00.000Z';

/**
 * Probes that attribute every live pid, so a case can exercise the reap itself.
 * Attribution has its own suite (`serverIdentity.test.ts`); the cases here that
 * care about it pass their own facts. Matches `FIXED_STARTED_AT` by default so
 * the no-cwd-probe path attributes too, without depending on wall-clock `now`.
 */
function attributingFacts(over: Partial<ProcessFacts> = {}): ProcessFacts {
  return {
    isAlive,
    liveCwd: (): LiveCwd | null => null,
    processStartMs: () => Date.parse(FIXED_STARTED_AT),
    ...over,
  };
}

interface Row {
  repo: string;
  cwd: string | null;
  pid: number | null;
  status?: string;
  ticketId?: number | null;
  container?: string | null;
}

describe('worktreeServers', () => {
  let store: Store;
  let dir: string;
  const spawned: ChildProcess[] = [];

  const insert = (row: Row): number => {
    const ticketId = row.ticketId === undefined ? 1 : row.ticketId;
    const info = store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at, container)
         VALUES (?, ?, 'localhost', 3000, ?, ?, '/l', ?, ?, ?)`,
      )
      .run(
        ticketId,
        row.repo,
        row.pid,
        row.status ?? 'running',
        row.cwd,
        FIXED_STARTED_AT,
        row.container ?? null,
      );
    return Number(info.lastInsertRowid);
  };

  const statusOf = (id: number): { status: string; pid: number | null } =>
    store.db.prepare('SELECT status, pid FROM servers WHERE id = ?').get(id) as {
      status: string;
      pid: number | null;
    };

  beforeEach(() => {
    removeContainerMock.mockClear();
    store = openStore(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'karst-wtsrv-'));
  });

  afterEach(() => {
    for (const c of spawned) {
      if (c.pid) {
        try {
          process.kill(-c.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    spawned.length = 0;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('stopServersUnder', () => {
    it('kills a server running IN the worktree and marks its row stopped', async () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      const child = spawnIdle();
      spawned.push(child);
      const id = insert({ repo: 'frontend', cwd: wt, pid: child.pid! });

      const reaped = stopServersUnder(store, wt, { facts: attributingFacts() });

      expect(reaped).toEqual([
        {
          id,
          repo: 'frontend',
          pid: child.pid,
          cwd: wt,
          reason: 'worktree-removed',
          container: null,
          outcome: 'killed',
        },
      ]);
      await waitUntilDead(child.pid!);
      // The row is RETAINED as stopped, like every other stop path, so the
      // server surfaces as offline instead of silently vanishing.
      expect(statusOf(id)).toEqual({ status: 'stopped', pid: null });
    });

    it('kills a server running in a SUBDIRECTORY of the worktree', () => {
      const wt = join(dir, 'worktrees', 'abc');
      const inner = join(wt, 'packages', 'web');
      mkdirSync(inner, { recursive: true });
      const id = insert({ repo: 'web', cwd: inner, pid: null });

      expect(stopServersUnder(store, wt).map((r) => r.id)).toEqual([id]);
    });

    it('leaves a sibling worktree whose slug merely shares the prefix', () => {
      const wt = join(dir, 'worktrees', 'abc');
      const sibling = join(dir, 'worktrees', 'abc-2');
      mkdirSync(wt, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      const id = insert({ repo: 'frontend', cwd: sibling, pid: null });

      expect(stopServersUnder(store, wt)).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });

    it('leaves rows with an unknown (NULL) cwd alone', () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      const id = insert({ repo: 'legacy', cwd: null, pid: null });

      expect(stopServersUnder(store, wt)).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });

    it('ignores already-stopped rows', () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      insert({ repo: 'frontend', cwd: wt, pid: null, status: 'stopped' });

      expect(stopServersUnder(store, wt)).toEqual([]);
    });

    it('works after the directory is already gone (canonicalization must not require it)', () => {
      const wt = join(dir, 'worktrees', 'gone');
      const id = insert({ repo: 'frontend', cwd: wt, pid: null });

      expect(stopServersUnder(store, wt).map((r) => r.id)).toEqual([id]);
    });

    // A recorded pid is a recollection, not a handle. `killTree` signals the
    // process GROUP, so acting on a pid the OS has reissued takes down an
    // unrelated process tree.
    it('never signals a pid it cannot attribute — it clears the row instead', async () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      const stranger = spawnIdle();
      spawned.push(stranger);
      const id = insert({ repo: 'frontend', cwd: wt, pid: stranger.pid! });

      // The OS says that pid is running somewhere else: it is not our server.
      const reaped = stopServersUnder(store, wt, {
        facts: attributingFacts({ liveCwd: () => ({ path: '/somewhere/else', deleted: false }) }),
      });

      expect(reaped[0]!.outcome).toBe('row-cleared');
      // The row stops claiming to run…
      expect(statusOf(id)).toEqual({ status: 'stopped', pid: null });
      // …and the process it named is untouched.
      await new Promise((r) => setTimeout(r, 100));
      expect(isAlive(stranger.pid!)).toBe(true);
    });

    // `killTree` distinguishes "signalled" from "refused" (EPERM: the process
    // exists and is still running). A refusal must not also erase the only
    // record that the process is out there — that would be worse than doing
    // nothing, since the row would then say 'stopped' about a live leak.
    it('leaves the row RUNNING when the kill is refused, and reports the failure truthfully', () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      const id = insert({ repo: 'frontend', cwd: wt, pid: 999999 });
      const denied: ProcessFacts = attributingFacts();
      // Force the real killTree (invoked with this pid) to observe EPERM by
      // stubbing process.kill for the duration of this call.
      const original = process.kill;
      process.kill = ((_pid: number, signal?: string | number) => {
        if (signal === 0) return true; // isAlive probe: pretend it's alive
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }) as typeof process.kill;

      let reaped;
      try {
        reaped = stopServersUnder(store, wt, { facts: denied });
      } finally {
        process.kill = original;
      }

      expect(reaped).toEqual([
        {
          id,
          repo: 'frontend',
          pid: 999999,
          cwd: wt,
          reason: 'worktree-removed',
          outcome: 'kill-failed',
          container: null,
        },
      ]);
      // Untouched — 'running' is still the true state.
      expect(statusOf(id)).toEqual({ status: 'running', pid: 999999 });
    });
  });

  describe('reapStaleServers', () => {
    it('stops a running server whose directory no longer exists', async () => {
      const gone = join(dir, 'worktrees', 'deleted');
      mkdirSync(join(dir, 'worktrees'), { recursive: true }); // parent stands
      const child = spawnIdle();
      spawned.push(child);
      const id = insert({ repo: 'frontend', cwd: gone, pid: child.pid! });

      const reaped = reapStaleServers(store, { facts: attributingFacts() });

      expect(reaped).toEqual([
        {
          id,
          repo: 'frontend',
          pid: child.pid,
          cwd: gone,
          reason: 'directory-gone',
          container: null,
          outcome: 'killed',
        },
      ]);
      await waitUntilDead(child.pid!);
      expect(statusOf(id)).toEqual({ status: 'stopped', pid: null });
    });

    it('leaves a server whose directory still exists', () => {
      const live = join(dir, 'worktrees', 'live');
      mkdirSync(live, { recursive: true });
      const id = insert({ repo: 'frontend', cwd: live, pid: null });

      expect(reapStaleServers(store)).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });

    it('never judges a row whose cwd is unknown', () => {
      const id = insert({ repo: 'legacy', cwd: null, pid: null });

      expect(reapStaleServers(store)).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });

    // An unmounted volume or a dropped network share takes every path under it,
    // including the parent. Reading that as "the worktree was removed" would
    // kill live servers over a blip.
    it('does not treat a whole vanished parent as a removed worktree', () => {
      const detached = join(dir, 'not-mounted', 'repo', '.karst', 'worktrees', 'abc');
      const id = insert({ repo: 'frontend', cwd: detached, pid: null });

      expect(reapStaleServers(store)).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });

    // Linux publishes a removed cwd as `<path> (deleted)` — direct evidence
    // about THIS process, and what the incident was diagnosed from.
    it("takes the OS's `(deleted)` answer as proof, even where the path reads as present", () => {
      const present = join(dir, 'worktrees', 'abc');
      mkdirSync(present, { recursive: true });
      const id = insert({ repo: 'frontend', cwd: present, pid: 4242 });

      const reaped = reapStaleServers(store, {
        facts: attributingFacts({
          isAlive: () => true,
          liveCwd: () => ({ path: present, deleted: true }),
        }),
      });

      expect(reaped.map((r) => [r.id, r.outcome])).toEqual([[id, 'killed']]);
    });

    it('leaves a live process whose cwd the OS reports as present', () => {
      const gone = join(dir, 'worktrees', 'deleted');
      mkdirSync(join(dir, 'worktrees'), { recursive: true });
      const id = insert({ repo: 'frontend', cwd: gone, pid: 4242 });

      expect(
        reapStaleServers(store, {
          facts: attributingFacts({ liveCwd: () => ({ path: gone, deleted: false }) }),
        }),
      ).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });

    // A baseline server (`ticket_id IS NULL`) is a shared singleton keyed to
    // the repository's own checkout, not to a removable worktree. This is the
    // unattended global sweep — its false-positive blast radius on a shared row
    // is every ticket, not one leftover worktree — so it stays out of scope.
    it('never judges a baseline server, even if its recorded directory is gone', () => {
      const gone = join(dir, 'worktrees', 'deleted');
      mkdirSync(join(dir, 'worktrees'), { recursive: true });
      const id = insert({ repo: 'frontend', cwd: gone, pid: null, ticketId: null });

      expect(reapStaleServers(store, { facts: attributingFacts() })).toEqual([]);
      expect(statusOf(id).status).toBe('running');
    });
  });

  describe('container services', () => {
    it('removes the container of a server under a removed worktree', () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      const child = spawnIdle();
      spawned.push(child);
      insert({ repo: 'db', cwd: wt, pid: child.pid!, container: 'karst-t1-db' });

      const [reaped] = stopServersUnder(store, wt, { facts: attributingFacts() });

      expect(removeContainerMock).toHaveBeenCalledWith('karst-t1-db', expect.anything());
      expect(reaped!.container).toBe('karst-t1-db');
    });

    it('removes the container even when the pid cannot be attributed', () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      const id = insert({ repo: 'db', cwd: wt, pid: 999999, container: 'karst-t1-db' });

      // Dead (or reissued) pid: nothing may be SIGNALLED, because the process
      // group may now belong to a stranger. The container name cannot be
      // reissued, so it is still removable — and a container left running is
      // exactly the leak the row would otherwise hide.
      const [reaped] = stopServersUnder(store, wt, {
        facts: attributingFacts({ isAlive: () => false }),
      });

      expect(reaped!.outcome).toBe('row-cleared');
      expect(removeContainerMock).toHaveBeenCalledWith('karst-t1-db', expect.anything());
      expect(statusOf(id).status).toBe('stopped');
    });

    it('removes nothing for a plain command service', () => {
      const wt = join(dir, 'worktrees', 'abc');
      mkdirSync(wt, { recursive: true });
      insert({ repo: 'frontend', cwd: wt, pid: 999999 });

      stopServersUnder(store, wt, { facts: attributingFacts({ isAlive: () => false }) });

      expect(removeContainerMock).not.toHaveBeenCalled();
    });

    it('names the removed container in the reported line', () => {
      const line = describeReap({
        id: 1,
        repo: 'db',
        pid: 4242,
        cwd: '/w/abc',
        reason: 'worktree-removed',
        outcome: 'killed',
        container: 'karst-t1-db',
      });
      expect(line).toContain("Removed container 'karst-t1-db'");
    });
  });

  describe('describeReap', () => {
    const base = { id: 1, repo: 'frontend', pid: 333080, cwd: '/w/abc', container: null } as const;

    it('states a kill, its reason and its path', () => {
      expect(describeReap({ ...base, reason: 'directory-gone', outcome: 'killed' })).toContain(
        "stopped 'frontend' (pid 333080) — its directory is gone: /w/abc",
      );
    });

    it('says plainly when nothing was signalled', () => {
      const line = describeReap({ ...base, reason: 'worktree-removed', outcome: 'row-cleared' });
      expect(line).toContain('Nothing was signalled');
    });

    it('reports a failed stop as a failure, never as a stop', () => {
      const line = describeReap({ ...base, reason: 'worktree-removed', outcome: 'kill-failed' });
      expect(line).toContain('could NOT stop');
    });
  });
});
