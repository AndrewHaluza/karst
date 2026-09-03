import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { probeBusyPorts, portsIn, portsToAvoid } from './portProbe.js';
import { openStore, type Store } from '../store/db.js';

describe('portsIn', () => {
  it('expands a range inclusively', () => {
    expect(portsIn([[3000, 3003]])).toEqual([3000, 3001, 3002, 3003]);
  });

  it('merges overlapping ranges without duplicating a port', () => {
    expect(portsIn([[3000, 3002], [3001, 3003]])).toEqual([3000, 3001, 3002, 3003]);
  });

  it('ignores an inverted range rather than looping forever', () => {
    expect(portsIn([[3005, 3000]])).toEqual([]);
  });
});

describe('probeBusyPorts', () => {
  it('reports only the ports something is listening on', async () => {
    const isPortOpen = vi.fn(async (_host: string, port: number) => port === 3001);
    const busy = await probeBusyPorts('127.0.0.1', [[3000, 3002]], { isPortOpen });
    expect([...busy]).toEqual([3001]);
    expect(isPortOpen).toHaveBeenCalledTimes(3);
  });

  it('probes a real listener end to end', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const busy = await probeBusyPorts('127.0.0.1', [[port, port]]);
      expect(busy.has(port)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const isPortOpen = async (): Promise<boolean> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return false;
    };
    await probeBusyPorts('127.0.0.1', [[3000, 3020]], { isPortOpen, concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('returns what it has when the overall budget expires, without throwing', async () => {
    const isPortOpen = async (_host: string, port: number): Promise<boolean> => {
      if (port === 3000) return true;
      await new Promise((r) => setTimeout(r, 5_000));
      return true;
    };
    const busy = await probeBusyPorts('127.0.0.1', [[3000, 3010]], {
      isPortOpen,
      concurrency: 1,
      budgetMs: 20,
    });
    expect(busy.has(3000)).toBe(true);
    expect(busy.size).toBeLessThan(11);
  });

  it('treats a probe that throws as free rather than failing the caller', async () => {
    const isPortOpen = async (_host: string, port: number): Promise<boolean> => {
      if (port === 3001) throw new Error('lsof exploded');
      return port === 3002;
    };
    const busy = await probeBusyPorts('127.0.0.1', [[3000, 3002]], { isPortOpen });
    expect([...busy]).toEqual([3002]);
  });

  it('returns an empty set for no ranges without probing', async () => {
    const isPortOpen = vi.fn(async () => true);
    expect((await probeBusyPorts('127.0.0.1', [], { isPortOpen })).size).toBe(0);
    expect(isPortOpen).not.toHaveBeenCalled();
  });
});

describe('portsToAvoid', () => {
  let store: Store;
  const REPO = '/repos/frontend';

  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  /** Facts for a live pid whose cwd is `cwd` (null = the OS will not say). */
  const factsFor = (cwd: string | null) => ({
    isAlive: async () => true,
    liveCwd: async () => (cwd === null ? null : { path: cwd, deleted: false }),
    processStartMs: async () => null,
  });

  it('avoids a port held by a stranger — karst may never reclaim it', async () => {
    const avoid = await portsToAvoid(store, '127.0.0.1', [[4000, 4001]], [REPO], {
      isPortOpen: async (_h, p) => p === 4000,
      listenerPids: async () => [999],
      facts: factsFor('/somewhere/else'),
    });
    expect([...avoid]).toEqual([4000]);
  });

  it('keeps a port held by a dev server of a hot repository allocatable', async () => {
    // startHot attributes and reclaims this one, on the SAME port — skipping it
    // would leave the leaked server holding a port of the range forever.
    const avoid = await portsToAvoid(store, '127.0.0.1', [[4000, 4001]], [REPO], {
      isPortOpen: async (_h, p) => p === 4000,
      listenerPids: async () => [999],
      facts: factsFor(`${REPO}/worktree`),
    });
    expect(avoid.size).toBe(0);
  });

  it('keeps a port allocatable when ANY of its listeners is reclaimable', async () => {
    const avoid = await portsToAvoid(store, '127.0.0.1', [[4000, 4000]], [REPO], {
      isPortOpen: async () => true,
      listenerPids: async () => [1, 2],
      facts: {
        isAlive: async () => true,
        liveCwd: async (pid: number) =>
          pid === 2 ? { path: `${REPO}/wt`, deleted: false } : { path: '/elsewhere', deleted: false },
        processStartMs: async () => null,
      },
    });
    expect(avoid.size).toBe(0);
  });

  it('avoids an occupied port whose listener cannot be identified', async () => {
    // Occupied but unattributable: karst will not guess, so reclaiming is
    // impossible and the port must not be handed out.
    const avoid = await portsToAvoid(store, '127.0.0.1', [[4000, 4000]], [REPO], {
      isPortOpen: async () => true,
      listenerPids: async () => [],
      facts: factsFor(null),
    });
    expect([...avoid]).toEqual([4000]);
  });

  it('probes nothing further when no port is busy', async () => {
    const listenerPids = vi.fn(async () => [1]);
    const avoid = await portsToAvoid(store, '127.0.0.1', [[4000, 4002]], [REPO], {
      isPortOpen: async () => false,
      listenerPids,
      facts: factsFor(null),
    });
    expect(avoid.size).toBe(0);
    expect(listenerPids).not.toHaveBeenCalled();
  });

  it('avoids a port held by a karst baseline server — never karst\'s to reclaim', async () => {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at)
         VALUES (NULL, 'backend', '127.0.0.1', 4000, 999, 'running', '/l', ?, ?)`,
      )
      .run(`${REPO}/wt`, new Date().toISOString());
    const avoid = await portsToAvoid(store, '127.0.0.1', [[4000, 4000]], [REPO], {
      isPortOpen: async () => true,
      listenerPids: async () => [999],
      facts: factsFor(`${REPO}/wt`),
    });
    expect([...avoid]).toEqual([4000]);
  });
});
