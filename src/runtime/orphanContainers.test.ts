import { describe, it, expect, vi } from 'vitest';
import type { spawn as SpawnFn } from 'node:child_process';
import { openStore, type Store } from '../store/db.js';
import { createTicket, setStageCurrent, archiveTicket } from '../store/tickets.js';
import {
  parseTicketContainerName,
  parseHostPorts,
  listTicketContainers,
  findOrphanContainers,
  removeOrphanContainers,
  type CommandExecutor,
} from './orphanContainers.js';

const spawnFn = vi.fn() as unknown as typeof SpawnFn;

/** A fake docker: `ps` listing for the filter, empty output for rm and verify. */
function fakeDocker(listing: string | null) {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'ps' && args.includes('-aq')) return '';
    if (args[0] === 'ps') return listing;
    return '';
  };
  return { exec, calls };
}

function seedServer(store: Store, ticketId: number | null, container: string | null, status = 'running') {
  store.db
    .prepare('INSERT INTO servers (ticket_id, repo, status, container) VALUES (?, ?, ?, ?)')
    .run(ticketId, 'app', status, container);
}

describe('parseTicketContainerName', () => {
  it('extracts the ticket id from a karst ticket container', () => {
    expect(parseTicketContainerName('karst-t42-app')).toEqual({ ticketId: 42 });
  });
  it('returns null for the baseline container', () => {
    expect(parseTicketContainerName('karst-baseline-app')).toBeNull();
  });
  it('returns null for names that are not ticket containers', () => {
    expect(parseTicketContainerName('karst-t-app')).toBeNull();
    expect(parseTicketContainerName('karst-tx1-app')).toBeNull();
    expect(parseTicketContainerName('other-t1-app')).toBeNull();
    expect(parseTicketContainerName('karst-t7-')).toBeNull();
  });
});

describe('parseHostPorts', () => {
  it('reads host ports from docker Ports text and dedupes them', () => {
    expect(parseHostPorts('0.0.0.0:8084->80/tcp, :::8084->80/tcp')).toEqual([8084]);
  });
  it('returns every distinct published host port', () => {
    expect(parseHostPorts('0.0.0.0:8084->80/tcp, 0.0.0.0:9000->9000/tcp')).toEqual([8084, 9000]);
  });
  it('returns [] when nothing is published', () => {
    expect(parseHostPorts('')).toEqual([]);
    expect(parseHostPorts('80/tcp')).toEqual([]);
  });
});

describe('listTicketContainers', () => {
  it('lists running ticket containers with their host ports and drops baseline', async () => {
    const { exec, calls } = fakeDocker(
      'karst-t1-app\t0.0.0.0:8084->80/tcp, :::8084->80/tcp\nkarst-baseline-app\t0.0.0.0:8000->80/tcp\nkarst-t2-web\t\n',
    );
    const result = await listTicketContainers({ commandOutput: exec, spawnFn });
    expect(result).toEqual([
      { name: 'karst-t1-app', ports: [8084] },
      { name: 'karst-t2-web', ports: [] },
    ]);
    expect(calls[0]).toEqual([
      'ps',
      '--filter',
      'name=^karst-t',
      '--format',
      '{{.Names}}\t{{.Ports}}',
    ]);
  });
  it('returns null when docker did not answer', async () => {
    const { exec } = fakeDocker(null);
    expect(await listTicketContainers({ commandOutput: exec, spawnFn })).toBeNull();
  });
});

describe('findOrphanContainers', () => {
  const containers = [
    { name: 'karst-t1-app', ports: [] },
    { name: 'karst-t2-app', ports: [] },
  ];
  it('returns names whose ticket is not live', () => {
    const live = (ticketId: number) => ticketId === 1;
    expect(findOrphanContainers(containers, live)).toEqual(['karst-t2-app']);
  });
  it('returns nothing when every ticket is live', () => {
    expect(findOrphanContainers(containers, () => true)).toEqual([]);
  });
});

describe('removeOrphanContainers', () => {
  it('removes a container with no running server row, and never the baseline', async () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'T-1', title: 'one' });
    seedServer(store, t.id, 'karst-t99-app');
    const { exec, calls } = fakeDocker(
      'karst-t1-app\t\nkarst-baseline-app\t0.0.0.0:8000->80/tcp\n',
    );
    const result = await removeOrphanContainers(store, { commandOutput: exec, spawnFn });
    expect(result).toEqual({ removed: ['karst-t1-app'], failed: [] });
    expect(calls.some((a) => a.includes('karst-baseline-app'))).toBe(false);
    expect(calls).toContainEqual(['rm', '-f', 'karst-t1-app']);
    store.close();
  });

  it('keeps a container whose exact name is a running server row of a live ticket', async () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'T-2', title: 'two' });
    seedServer(store, t.id, 'karst-t2-app');
    const { exec, calls } = fakeDocker('karst-t2-app\t\n');
    const result = await removeOrphanContainers(store, { commandOutput: exec, spawnFn });
    expect(result).toEqual({ removed: [], failed: [] });
    expect(calls.some((a) => a[0] === 'rm')).toBe(false);
    store.close();
  });

  it('treats a container of a done or archived ticket as orphaned', async () => {
    const store = openStore(':memory:');
    const done = createTicket(store, { key: 'T-3', title: 'three' });
    setStageCurrent(store, done.id, 'done');
    seedServer(store, done.id, 'karst-t3-app');
    const archived = createTicket(store, { key: 'T-4', title: 'four' });
    seedServer(store, archived.id, 'karst-t4-app');
    archiveTicket(store, archived.id);
    const { exec } = fakeDocker('karst-t3-app\t\nkarst-t4-app\t\n');
    const result = await removeOrphanContainers(store, { commandOutput: exec, spawnFn });
    expect(result.removed.sort()).toEqual(['karst-t3-app', 'karst-t4-app']);
    store.close();
  });

  it('records a failed removal and continues with the rest', async () => {
    const store = openStore(':memory:');
    const calls: string[][] = [];
    const exec: CommandExecutor = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'ps' && args.includes('-aq')) return 'still-here';
      if (args[0] === 'ps') return 'karst-t5-app\t\nkarst-t6-app\t\n';
      return '';
    };
    const result = await removeOrphanContainers(store, { commandOutput: exec, spawnFn });
    expect(result).toEqual({ removed: [], failed: ['karst-t5-app', 'karst-t6-app'] });
    store.close();
  });

  it('returns an empty result when docker did not answer', async () => {
    const store = openStore(':memory:');
    const { exec, calls } = fakeDocker(null);
    const result = await removeOrphanContainers(store, { commandOutput: exec, spawnFn });
    expect(result).toEqual({ removed: [], failed: [] });
    expect(calls.some((a) => a[0] === 'rm')).toBe(false);
    store.close();
  });
});
