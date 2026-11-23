import { describe, it, expect, vi } from 'vitest';

import { openStore, type Store } from '../store/db.js';
import { sweepServerLiveness, describeCrashed } from './livenessSweep.js';

interface SeedOptions {
  ticketId?: number | null;
  repo?: string;
  host?: string | null;
  port?: number | null;
  pid?: number | null;
  status?: 'running' | 'stopped' | 'failed';
  kind?: 'service' | 'agent';
  container?: string | null;
  sandbox?: string | null;
}

function seedServer(store: Store, opts: SeedOptions = {}): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind, log_path, container, sandbox)
       VALUES (?, ?, ?, ?, ?, ?, ?, '/l', ?, ?)`,
    )
    .run(
      opts.ticketId === undefined ? 1 : opts.ticketId,
      opts.repo ?? 'api',
      opts.host === undefined ? '127.0.0.1' : opts.host,
      opts.port === undefined ? 8000 : opts.port,
      opts.pid === undefined ? 4242 : opts.pid,
      opts.status ?? 'running',
      opts.kind ?? 'service',
      opts.container ?? null,
      opts.sandbox ?? null,
    );
  return Number(info.lastInsertRowid);
}

function statusOf(store: Store, id: number): string {
  return (
    store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string }
  ).status;
}

function lastErrorOf(store: Store, id: number): string | null {
  return (
    store.db.prepare('SELECT last_error AS e FROM servers WHERE id = ?').get(id) as { e: string | null }
  ).e;
}

/** A dead pid whose process group is also gone: the default for a crash. */
const dead = { isPidAlive: () => false, isGroupAlive: () => 'empty' as const };

function pidOf(store: Store, id: number): number | null {
  return (
    store.db.prepare('SELECT pid FROM servers WHERE id = ?').get(id) as { pid: number | null }
  ).pid;
}

describe('sweepServerLiveness', () => {
  it('leaves a row with a live pid untouched', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });
    const portOpen = vi.fn(async () => false);

    const crashed = await sweepServerLiveness(store, { isPidAlive: () => true, portOpen });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('leaves a row with a dead pid but a bound port untouched (a daemonised launcher)', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });
    const portOpen = vi.fn(async () => true);

    const crashed = await sweepServerLiveness(store, { ...dead, portOpen });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
    expect(portOpen).toHaveBeenCalledWith('127.0.0.1', 8000);
  });

  it('leaves a row untouched while its process group is alive, without a port probe', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });
    const portOpen = vi.fn(async () => false);

    const crashed = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      isGroupAlive: () => 'alive',
      portOpen,
    });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('marks a row failed when the pid is dead, the group is empty and the port refuses', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { ticketId: 7, repo: 'api', pid: 4242 });

    const crashed = await sweepServerLiveness(store, { ...dead, portOpen: async () => false });

    expect(statusOf(store, id)).toBe('failed');
    expect(pidOf(store, id)).toBeNull();
    expect(lastErrorOf(store, id)).toBe('Exited unexpectedly');
    expect(crashed).toEqual([
      { id, ticketId: 7, service: 'api', pid: 4242, reason: 'Exited unexpectedly' },
    ]);
  });

  it('never writes stopped for a crash', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });

    await sweepServerLiveness(store, { ...dead, portOpen: async () => false });

    expect(statusOf(store, id)).not.toBe('stopped');
  });

  it('uses the pid + port rule when the group answer is unknown (Windows)', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });

    const crashed = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      isGroupAlive: () => 'unknown',
      portOpen: async () => false,
    });

    expect(crashed.map((c) => c.id)).toEqual([id]);
    expect(statusOf(store, id)).toBe('failed');
  });

  it('names the exit code in the reason when the starting window saw a non-zero exit, then forgets it', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });
    const exitCodes = new Map<number, number>([[id, 1]]);

    const crashed = await sweepServerLiveness(store, { ...dead, portOpen: async () => false, exitCodes });

    expect(crashed[0]?.reason).toBe('Exited with code 1');
    expect(lastErrorOf(store, id)).toBe('Exited with code 1');
    expect(exitCodes.has(id)).toBe(false);
  });

  it('keeps the exit code of a row that stays running', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });
    const exitCodes = new Map<number, number>([[id, 1]]);

    await sweepServerLiveness(store, { ...dead, portOpen: async () => true, exitCodes });

    expect(exitCodes.get(id)).toBe(1);
  });

  it('never flips a row with no host or port', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { host: null, port: null, pid: 4242 });
    const portOpen = vi.fn(async () => false);

    const crashed = await sweepServerLiveness(store, { ...dead, portOpen });

    expect(portOpen).not.toHaveBeenCalled();
    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
  });

  it('leaves a dead row on another ticket alone when scoped to one ticket', async () => {
    const store = openStore(':memory:');
    const mine = seedServer(store, { ticketId: 1, pid: 1111 });
    const other = seedServer(store, { ticketId: 2, pid: 2222 });

    const crashed = await sweepServerLiveness(store, {
      ticketId: 1,
      ...dead,
      portOpen: async () => false,
    });

    expect(crashed.map((r) => r.id)).toEqual([mine]);
    expect(statusOf(store, mine)).toBe('failed');
    expect(statusOf(store, other)).toBe('running');
  });

  it('never selects rows whose kind is not service', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { kind: 'agent', pid: 4242 });
    const portOpen = vi.fn(async () => false);

    const crashed = await sweepServerLiveness(store, { ...dead, portOpen });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('leaves a row running when its port probe rejects, without throwing', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });

    const crashed = await sweepServerLiveness(store, {
      ...dead,
      portOpen: async () => {
        throw new Error('probe exploded');
      },
    });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
  });

  it('leaves a row running when its port probe cannot answer (timeout → unknown)', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });

    const crashed = await sweepServerLiveness(store, { ...dead, portOpen: async () => undefined });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
  });

  it('does not overwrite a row that a user Stop changed during the probe', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });

    const crashed = await sweepServerLiveness(store, {
      ...dead,
      portOpen: async () => {
        store.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(id);
        return false;
      },
    });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('stopped');
  });
});

describe('sweepServerLiveness: sandbox rows (pid NULL, no container)', () => {
  it('marks a sandbox row failed when its port refuses', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: null, sandbox: 'sbx:box:3000' });

    const crashed = await sweepServerLiveness(store, { portOpen: async () => false });

    expect(crashed.map((c) => c.id)).toEqual([id]);
    expect(statusOf(store, id)).toBe('failed');
  });

  it('keeps a sandbox row whose port answers', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: null, sandbox: 'sbx:box:3000' });

    const crashed = await sweepServerLiveness(store, { portOpen: async () => true });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
  });
});

describe('sweepServerLiveness: container rows', () => {
  it('marks a pid-less container row failed when its container is gone, ignoring a port another ticket holds', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: null, container: 'karst-t99-db' });
    const portOpen = vi.fn(async () => true);

    const crashed = await sweepServerLiveness(store, {
      portOpen,
      containerRunning: async () => false,
    });

    expect(crashed.map((r) => r.id)).toEqual([id]);
    expect(statusOf(store, id)).toBe('failed');
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('keeps a container row with a dead client pid while the container runs', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242, container: 'karst-api' });
    const portOpen = vi.fn(async () => false);

    const crashed = await sweepServerLiveness(store, {
      ...dead,
      portOpen,
      containerRunning: async () => true,
    });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('marks a container row with a client pid failed when the container is gone, without removing the container', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242, container: 'karst-api' });

    const crashed = await sweepServerLiveness(store, {
      isPidAlive: () => true,
      containerRunning: async () => false,
    });

    expect(crashed.map((r) => r.id)).toEqual([id]);
    expect(statusOf(store, id)).toBe('failed');
    expect(pidOf(store, id)).toBeNull();
    // The sweep never runs `docker rm -f`; only the explicit stop/reap paths may.
    const row = store.db.prepare('SELECT container FROM servers WHERE id = ?').get(id) as {
      container: string | null;
    };
    expect(row.container).toBe('karst-api');
  });

  it('keeps a pid-less container row whose container is running', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: null, container: 'karst-t99-db' });

    const crashed = await sweepServerLiveness(store, { containerRunning: async () => true });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
  });

  it('leaves the row alone when docker did not answer', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: null, container: 'karst-t99-db' });

    const crashed = await sweepServerLiveness(store, { containerRunning: async () => undefined });

    expect(crashed).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
  });
});

describe('describeCrashed', () => {
  it('renders both the with-ticket and the baseline wording', () => {
    const base = { id: 3, service: 'api', reason: 'Exited unexpectedly' };
    expect(describeCrashed({ ...base, ticketId: 583, pid: 4242 })).toBe(
      "karst: 'api' exited unexpectedly (pid 4242) on ticket T583 — marked failed.",
    );
    expect(describeCrashed({ ...base, ticketId: null, pid: null })).toBe(
      "karst: 'api' exited unexpectedly (pid unknown) — marked failed.",
    );
  });
});

