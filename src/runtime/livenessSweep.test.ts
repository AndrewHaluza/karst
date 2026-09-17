import { describe, it, expect, vi } from 'vitest';

import { openStore, type Store } from '../store/db.js';
import { sweepServerLiveness, describeRetired } from './livenessSweep.js';

interface SeedOptions {
  ticketId?: number | null;
  repo?: string;
  host?: string | null;
  port?: number | null;
  pid?: number | null;
  status?: 'running' | 'stopped';
  kind?: 'service' | 'agent';
  container?: string | null;
}

function seedServer(store: Store, opts: SeedOptions = {}): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind, log_path, container)
       VALUES (?, ?, ?, ?, ?, ?, ?, '/l', ?)`,
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
    );
  return Number(info.lastInsertRowid);
}

function statusOf(store: Store, id: number): string {
  return (
    store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as { status: string }
  ).status;
}

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

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => true,
      portOpen,
    });

    expect(retired).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('leaves a row with a dead pid but a bound port untouched', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });
    const portOpen = vi.fn(async () => true);

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen,
    });

    expect(retired).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
    expect(portOpen).toHaveBeenCalledWith('127.0.0.1', 8000);
  });

  it('retires a row with a dead pid and a closed port', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { ticketId: 7, repo: 'api', pid: 4242 });

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen: async () => false,
    });

    expect(statusOf(store, id)).toBe('stopped');
    expect(pidOf(store, id)).toBeNull();
    expect(retired).toEqual([{ id, ticketId: 7, service: 'api', pid: 4242 }]);
  });

  it('retires a container-backed row without touching its container', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242, container: 'karst-api' });

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen: async () => false,
    });

    expect(retired.map((r) => r.id)).toEqual([id]);
    expect(statusOf(store, id)).toBe('stopped');
    // The sweep never runs `docker rm -f`: a refused port is no proof the
    // container is dead, and only the explicit stop/reap paths may remove it.
    const row = store.db.prepare('SELECT container FROM servers WHERE id = ?').get(id) as {
      container: string | null;
    };
    expect(row.container).toBe('karst-api');
  });

  it('retires a row with null host/port and a dead pid without probing a port', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { host: null, port: null, pid: 4242 });
    const portOpen = vi.fn(async () => true);

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen,
    });

    expect(portOpen).not.toHaveBeenCalled();
    expect(statusOf(store, id)).toBe('stopped');
    expect(retired.map((r) => r.id)).toEqual([id]);
  });

  it('leaves a dead row on another ticket alone when scoped to one ticket', async () => {
    const store = openStore(':memory:');
    const mine = seedServer(store, { ticketId: 1, pid: 1111 });
    const other = seedServer(store, { ticketId: 2, pid: 2222 });

    const retired = await sweepServerLiveness(store, {
      ticketId: 1,
      isPidAlive: () => false,
      portOpen: async () => false,
    });

    expect(retired.map((r) => r.id)).toEqual([mine]);
    expect(statusOf(store, mine)).toBe('stopped');
    expect(statusOf(store, other)).toBe('running');
  });

  it('never selects rows whose kind is not service', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { kind: 'agent', pid: 4242 });
    const portOpen = vi.fn(async () => false);

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen,
    });

    expect(retired).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(portOpen).not.toHaveBeenCalled();
  });

  it('leaves a row running when its port probe rejects, without throwing', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242 });

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen: async () => {
        throw new Error('probe exploded');
      },
    });

    expect(retired).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
  });

  it('leaves a row running when its port probe cannot answer (timeout \u2192 unknown)', async () => {
    const store = openStore(':memory:');
    const id = seedServer(store, { pid: 4242, container: 'karst-api' });

    const retired = await sweepServerLiveness(store, {
      isPidAlive: () => false,
      portOpen: async () => undefined,
    });

    expect(retired).toEqual([]);
    expect(statusOf(store, id)).toBe('running');
    expect(pidOf(store, id)).toBe(4242);
    const row = store.db.prepare('SELECT container FROM servers WHERE id = ?').get(id) as {
      container: string | null;
    };
    expect(row.container).toBe('karst-api');
  });
});

describe('describeRetired', () => {
  it('renders both the with-ticket and the baseline wording', () => {
    expect(describeRetired({ id: 3, ticketId: 7, service: 'api', pid: 4242 })).toBe(
      "karst: 'api' is no longer running (pid 4242) on ticket #7 \u2014 marked offline.",
    );
    expect(describeRetired({ id: 3, ticketId: null, service: 'api', pid: null })).toBe(
      "karst: 'api' is no longer running (pid unknown) \u2014 marked offline.",
    );
  });
});
