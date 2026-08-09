import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { isPortOpen, listenerPids, decideReclaim, reclaimPort } from './portConflict.js';
import { freePortWindow } from './fixtures.js';
import type { ProcessFacts, ProcessFactsSource } from './serverIdentity.js';
import { killTree } from './processTree.js';

vi.mock('./processTree.js', () => ({ killTree: vi.fn() }));

let portCounter = 48400;
function nextPort(): number {
  return portCounter++;
}

describe('isPortOpen', () => {
  beforeAll(async () => {
    portCounter = await freePortWindow(40, portCounter);
  });

  it('is false for a port nothing has bound', async () => {
    const port = nextPort();
    expect(await isPortOpen('127.0.0.1', port)).toBe(false);
  });

  it('is true when something accepts connections on the port — even if it answers nothing', async () => {
    const port = nextPort();
    const srv = createServer(); // answers nothing, the way a deaf squatter does
    await new Promise<void>((r) => srv.listen(port, () => r()));
    try {
      expect(await isPortOpen('127.0.0.1', port)).toBe(true);
      // A wildcard listener is reachable through both loopback families.
      expect(await isPortOpen('::1', port)).toBe(true);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('does not treat an IPv6-only listener as occupying the IPv4 service address', async () => {
    const port = nextPort();
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen({ host: '::1', port, ipv6Only: true }, resolve);
    });
    try {
      expect(await isPortOpen('::1', port)).toBe(true);
      expect(await isPortOpen('127.0.0.1', port)).toBe(false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('listenerPids', () => {
  beforeAll(async () => {
    portCounter = await freePortWindow(40, portCounter);
  });

  it('discovers listeners asynchronously so the extension host stays responsive', async () => {
    const lookup = listenerPids('127.0.0.1', nextPort());
    expect(lookup).toBeInstanceOf(Promise);
    await lookup;
  });

  it('returns within its deadline when hostname resolution stalls', async () => {
    const result = await Promise.race([
      listenerPids('stalled.test', nextPort(), {
        timeoutMs: 25,
        lookupHost: () => new Promise(() => {}),
      }),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 250)),
    ]);

    expect(result).toEqual([]);
  });

  it('names the process LISTENING on the port, and nothing for a free one', async () => {
    const port = nextPort();
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(port, () => r()));
    try {
      expect(await listenerPids('127.0.0.1', port)).toContain(process.pid);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await listenerPids('127.0.0.1', port)).toEqual([]);
  });

  it('returns only listeners that occupy the requested address family', async () => {
    const port = nextPort();
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen({ host: '::1', port, ipv6Only: true }, resolve);
    });
    try {
      expect(await listenerPids('::1', port)).toContain(process.pid);
      expect(await listenerPids('127.0.0.1', port)).not.toContain(process.pid);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('finds a dual-stack wildcard listener for a v4 service host — the Linux default bind', async () => {
    const port = nextPort();
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      // `listen(port)` binds `::` dual-stack; it BLOCKS a later 127.0.0.1 bind,
      // so discovery must name it even though it is not a v4 socket (this is
      // the squatter the incident reported: lsof -i4TCP misses it on Linux).
      srv.listen(port, resolve);
    });
    try {
      expect(await listenerPids('127.0.0.1', port)).toContain(process.pid);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('reclaimPort', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => {
    vi.mocked(killTree).mockReset();
    store.close();
  });

  it('keeps a recorded server running when an asynchronous kill does not release its port', async () => {
    const port = nextPort();
    const repoPath = '/repo/fe';
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', resolve);
    });
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (9, 'fe', '127.0.0.1', ?, ?, 'running', '/tmp/fe.log', ?, ?)`,
      )
      .run(port, process.pid, repoPath, '2026-08-03T07:00:00.000Z');
    vi.mocked(killTree).mockReturnValue('unknown');
    const facts: ProcessFacts = {
      isAlive: () => true,
      liveCwd: () => ({ path: repoPath, deleted: false }),
      processStartMs: () => null,
    };

    try {
      const outcome = await reclaimPort(store, '127.0.0.1', port, repoPath, facts);

      expect(outcome.portFree).toBe(false);
      expect(outcome.stoppedRows).toEqual([]);
      expect(outcome.survivors).toEqual([{ pid: process.pid }]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('does not retire a live server when an uncertain kill merely releases its socket', async () => {
    const port = nextPort();
    const repoPath = '/repo/fe';
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', resolve);
    });
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (9, 'fe', '127.0.0.1', ?, ?, 'running', '/tmp/fe.log', ?, ?)`,
      )
      .run(port, process.pid, repoPath, '2026-08-03T07:00:00.000Z');
    vi.mocked(killTree).mockImplementation(() => {
      srv.close();
      return 'unknown';
    });
    const facts: ProcessFacts = {
      isAlive: () => true,
      liveCwd: () => ({ path: repoPath, deleted: false }),
      processStartMs: () => null,
    };

    const outcome = await reclaimPort(store, '127.0.0.1', port, repoPath, facts);

    expect(outcome.portFree).toBe(false);
    expect(outcome.killedPids).toEqual([]);
    expect(outcome.stoppedRows).toEqual([]);
    expect(outcome.survivors).toEqual([{ pid: process.pid }]);
  });

  it('awaits and caches asynchronous process attribution facts for each listener', async () => {
    const port = nextPort();
    const repoPath = '/repo/fe';
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', resolve);
    });
    let cwdCalls = 0;
    const asyncFacts: ProcessFactsSource = {
      isAlive: async () => true,
      liveCwd: async () => {
        cwdCalls++;
        return { path: repoPath, deleted: false };
      },
      processStartMs: async () => null,
    };
    vi.mocked(killTree).mockImplementation(() => {
      srv.close();
      return 'killed';
    });

    const outcome = await reclaimPort(store, '127.0.0.1', port, repoPath, asyncFacts);

    expect(outcome.portFree).toBe(true);
    expect(outcome.killedPids).toEqual([process.pid]);
    expect(cwdCalls).toBe(1);
  });

  it('refuses to reclaim a port held by a baseline server — the shared singleton survives', async () => {
    const port = nextPort();
    const repoPath = '/repo/fe';
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', resolve);
    });
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (NULL, 'fe', '127.0.0.1', ?, ?, 'running', '/tmp/fe.log', ?, ?)`,
      )
      .run(port, process.pid, repoPath, '2026-08-03T07:00:00.000Z');

    try {
      const outcome = await reclaimPort(store, '127.0.0.1', port, repoPath);

      expect(outcome.portFree).toBe(false);
      expect(outcome.killedPids).toEqual([]);
      expect(outcome.stoppedRows).toEqual([]);
      expect(outcome.survivors).toEqual([{ pid: process.pid, baseline: true }]);
      expect(vi.mocked(killTree)).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe('decideReclaim', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  const repoPath = '/repo/fe';

  function facts(over: Partial<ProcessFacts> = {}): ProcessFacts {
    return {
      isAlive: () => true,
      liveCwd: () => null,
      processStartMs: () => null,
      ...over,
    };
  }

  it('kills a listener whose live cwd is inside the repository — a worktree dev server', () => {
    const f = facts({
      liveCwd: () => ({ path: join(repoPath, '.karst', 'worktrees', 'abc'), deleted: false }),
    });
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: true });
  });

  it('kills a listener whose live cwd IS the repository root — the main-checkout dev server', () => {
    const f = facts({ liveCwd: () => ({ path: repoPath, deleted: false }) });
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: true });
  });

  it('kills a listener whose cwd is a deleted worktree — the leaked-server case', () => {
    const f = facts({
      liveCwd: () => ({ path: join(repoPath, '.karst', 'worktrees', 'abc'), deleted: true }),
    });
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: true });
  });

  it('refuses a listener running OUTSIDE the repository — an unrelated app', () => {
    const f = facts({ liveCwd: () => ({ path: '/elsewhere', deleted: false }) });
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: false });
  });

  it('refuses when the platform cannot report the listener’s cwd', () => {
    expect(decideReclaim(store, 4242, repoPath, facts())).toEqual({ kill: false });
  });

  it('kills a listener that is an attributable karst-recorded server of ANY ticket, naming its row', () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (9, 'fe', '127.0.0.1', 3005, 4242, 'running', '/tmp/fe.log', ?, ?)`,
      )
      .run(repoPath, '2026-08-03T07:00:00.000Z');
    const f = facts({ liveCwd: () => ({ path: repoPath, deleted: false }) });
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: true, rowId: 1 });
  });

  it('refuses when the listener’s servers row does not attribute it — the pid was reissued', () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (9, 'fe', '127.0.0.1', 3005, 4242, 'running', '/tmp/fe.log', '/recorded/elsewhere', ?)`,
      )
      .run('2026-08-03T07:00:00.000Z');
    const f = facts({ liveCwd: () => ({ path: '/nowhere', deleted: false }) });
    // cwd equality fails against the row AND against the repository → refuse.
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: false });
  });

  it('ignores a STOPPED row — a retained offline row must not license a kill', () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (9, 'fe', '127.0.0.1', 3005, NULL, 'stopped', '/tmp/fe.log', ?, ?)`,
      )
      .run(repoPath, '2026-08-03T07:00:00.000Z');
    const f = facts({ liveCwd: () => ({ path: repoPath, deleted: false }) });
    // No running row, but the cwd containment still kills — the repo dev server
    // is the repo dev server whether or not karst recorded it.
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: true });
  });

  it('never kills a baseline server — a shared singleton is not a ticket conflict', () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (NULL, 'fe', '127.0.0.1', 3005, 4242, 'running', '/tmp/fe.log', ?, ?)`,
      )
      .run(repoPath, '2026-08-03T07:00:00.000Z');
    const f = facts({ liveCwd: () => ({ path: repoPath, deleted: false }) });
    // Both rules would license the kill (attributable row AND cwd containment),
    // yet a baseline must survive: it is the shared singleton `reapStaleServers`
    // also refuses to reap, and killing it costs every ticket that depends on it.
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: false, baseline: true });
  });

  it('retires the running row when the repository rule licenses the kill of its pid', () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (9, 'fe', '127.0.0.1', 3005, 4242, 'running', '/tmp/fe.log', '/recorded/elsewhere', ?)`,
      )
      .run('2026-08-03T07:00:00.000Z');
    const f = facts({ liveCwd: () => ({ path: repoPath, deleted: false }) });
    // The row does not attribute the pid (recorded cwd differs), but the live
    // cwd is inside the repository — the row cannot be about the process the
    // OS reports here, so it is retired with the kill rather than left
    // phantom-running over a dead pid.
    expect(decideReclaim(store, 4242, repoPath, f)).toEqual({ kill: true, rowId: 1 });
  });
});
