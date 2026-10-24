import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, archiveTicket } from './tickets.js';
import { pinBaseline } from './baselinePins.js';
import { listProjectServers } from './serverInventory.js';
import { manifest, runnableRepo, repo } from '../manifest/fixtures.js';

const M = manifest({ api: runnableRepo(), web: runnableRepo(), docs: repo() });

function addServer(
  store: Store,
  ticketId: number | null,
  name: string,
  status = 'running',
  extra: { kind?: string; port?: number } = {},
): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind, log_path, cwd, started_at)
       VALUES (?, ?, 'localhost', ?, 1, ?, ?, '/tmp/l.log', '/wt', '2026-01-01T00:00:00.000Z')`,
    )
    .run(ticketId, name, extra.port ?? 3000, status, extra.kind ?? 'service');
  return Number(info.lastInsertRowid);
}

function addRef(store: Store, ticketId: number, repoName: string): void {
  store.db.prepare('INSERT INTO baseline_refs (ticket_id, repo) VALUES (?, ?)').run(ticketId, repoName);
}

function setStage(store: Store, id: number, stage: string): void {
  store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, id);
}

describe('listProjectServers', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('is empty for an unknown project with no shared rows', () => {
    expect(listProjectServers(store, M, 999)).toEqual({ shared: [], tickets: [] });
  });

  it('lists shared rows running and stopped, running first then by repo, with pin and base branch', () => {
    addServer(store, null, 'web', 'stopped');
    addServer(store, null, 'api', 'running');
    pinBaseline(store, 'api');
    const { shared } = listProjectServers(store, M, 1);
    expect(shared.map((s) => [s.repo, s.status, s.pinned])).toEqual([
      ['api', 'running', true],
      ['web', 'stopped', false],
    ]);
    expect(shared[0]).toMatchObject({ host: 'localhost', port: 3000, logPath: '/tmp/l.log', cwd: '/wt', baseBranch: 'develop' });
  });

  it('omits shared rows for units the manifest no longer declares and agent rows', () => {
    addServer(store, null, 'gone', 'running');
    addServer(store, null, 'api', 'running', { kind: 'agent' });
    expect(listProjectServers(store, M, 1).shared).toEqual([]);
  });

  it('does not invent a row for a baseline ref with no server', () => {
    const t = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    addRef(store, t.id, 'api');
    expect(listProjectServers(store, M, 1).shared).toEqual([]);
  });

  it('dedupes retained rows per unit: running wins, else the newest', () => {
    addServer(store, null, 'api', 'stopped');
    const newest = addServer(store, null, 'api', 'stopped');
    addServer(store, null, 'web', 'stopped');
    const run = addServer(store, null, 'web', 'running');
    addServer(store, null, 'web', 'stopped');
    const { shared } = listProjectServers(store, M, 1);
    expect(shared.map((s) => [s.repo, s.id])).toEqual([['web', run], ['api', newest]]);
  });

  it('names live dependents, marks done-but-running ones, drops archived and idle-done', () => {
    addServer(store, null, 'api', 'running');
    const live = createTicket(store, { key: 'L', title: 'l', projectId: 1 });
    const doneRunning = createTicket(store, { key: 'D', title: 'd', projectId: 1 });
    const doneIdle = createTicket(store, { key: 'I', title: 'i', projectId: 1 });
    const archived = createTicket(store, { key: 'X', title: 'x', projectId: 1 });
    for (const t of [live, doneRunning, doneIdle, archived]) addRef(store, t.id, 'api');
    setStage(store, doneRunning.id, 'done');
    setStage(store, doneIdle.id, 'done');
    addServer(store, doneRunning.id, 'web', 'running');
    archiveTicket(store, archived.id);
    const dependents = listProjectServers(store, M, 1).shared[0]!.dependents;
    expect(dependents).toEqual([
      { ticketId: live.id, key: 'L', title: 'l', done: false },
      { ticketId: doneRunning.id, key: 'D', title: 'd', done: true },
    ]);
  });

  it('groups ticket stacks of the project only, running groups first then by id, rows running first', () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const b = createTicket(store, { key: 'B', title: 'b', projectId: 1 });
    const other = createTicket(store, { key: 'O', title: 'o', projectId: 2 });
    addServer(store, a.id, 'web', 'stopped');
    addServer(store, b.id, 'web', 'stopped');
    addServer(store, b.id, 'api', 'running');
    addServer(store, other.id, 'web', 'running');
    const { tickets } = listProjectServers(store, M, 1);
    expect(tickets.map((g) => g.key)).toEqual(['B', 'A']);
    expect(tickets[0]!.servers.map((s) => s.repo)).toEqual(['api', 'web']);
  });

  it('keeps archived tickets only while a row still runs (leftovers)', () => {
    const arch = createTicket(store, { key: 'AR', title: 'ar', projectId: 1 });
    const archStopped = createTicket(store, { key: 'AS', title: 'as', projectId: 1 });
    addServer(store, arch.id, 'web', 'running');
    addServer(store, arch.id, 'api', 'stopped');
    addServer(store, archStopped.id, 'web', 'stopped');
    archiveTicket(store, arch.id);
    archiveTicket(store, archStopped.id);
    const { tickets } = listProjectServers(store, M, 1);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ key: 'AR', archived: true });
    expect(tickets[0]!.servers.map((s) => s.repo)).toEqual(['web']);
  });

  it('flags a done group and carries its stage', () => {
    const t = createTicket(store, { key: 'D', title: 'd', projectId: 1 });
    setStage(store, t.id, 'done');
    addServer(store, t.id, 'web', 'running');
    expect(listProjectServers(store, M, 1).tickets[0]).toMatchObject({ done: true, stage: 'done', archived: false });
  });

  it('sets dependencyDown when any baseline ref has no running baseline row', () => {
    const t = createTicket(store, { key: 'T', title: 't', projectId: 1 });
    addServer(store, t.id, 'web', 'running');
    addRef(store, t.id, 'api');
    addRef(store, t.id, 'docs');
    addServer(store, null, 'docs', 'running');
    addServer(store, null, 'api', 'stopped');
    const g = listProjectServers(store, M, 1).tickets[0]!;
    expect(g).toMatchObject({ dependencyDown: true, downServices: ['api'] });
    store.db.prepare("UPDATE servers SET status = 'running' WHERE repo = 'api'").run();
    expect(listProjectServers(store, M, 1).tickets[0]).toMatchObject({ dependencyDown: false, downServices: [] });
  });
});
