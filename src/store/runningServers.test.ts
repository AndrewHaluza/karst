import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { upsertProject } from './projects.js';
import { listRunningServers, listTicketLifecycle } from './runningServers.js';

function seedServer(
  store: Store,
  ticketId: number | null,
  repo: string,
  status: 'running' | 'stopped' = 'running',
): { id: number; pid: number } {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd)
       VALUES (?, ?, 'localhost', 5173, 4242, ?, '/tmp/x.log', '2026-08-12T10:00:00.000Z', '/tmp/wt/x')`,
    )
    .run(ticketId, repo, status);
  return { id: Number(info.lastInsertRowid), pid: 4242 };
}

describe('listRunningServers', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns only status=running rows; a stopped row is excluded', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedServer(store, a.id, 'web', 'running');
    seedServer(store, a.id, 'api', 'stopped');

    const rows = listRunningServers(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo).toBe('web');
    expect(rows[0]!.ticketId).toBe(a.id);
  });

  it('surfaces the row facts the inventory and waste rules need', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedServer(store, a.id, 'web', 'running');

    const row = listRunningServers(store)[0]!;
    expect(row).toMatchObject({
      pid: 4242,
      cwd: '/tmp/wt/x',
      startedAt: '2026-08-12T10:00:00.000Z',
      host: 'localhost',
      port: 5173,
      repo: 'web',
    });
  });

  it('keeps a baseline row (ticket_id NULL) under project scoping', () => {
    const project = upsertProject(store, { slug: 'p1', name: 'p1' });
    const a = createTicket(store, { key: 'A', title: 'a', projectId: project.id });
    seedServer(store, a.id, 'web', 'running');
    seedServer(store, null, 'baseline', 'running');

    const rows = listRunningServers(store, project.id);
    const repos = rows.map((r) => r.repo).sort();
    expect(repos).toEqual(['baseline', 'web']);
  });

  it('excludes a row of another project when projectId is passed', () => {
    const p1 = upsertProject(store, { slug: 'p1', name: 'p1' });
    const p2 = upsertProject(store, { slug: 'p2', name: 'p2' });
    const a = createTicket(store, { key: 'A', title: 'a', projectId: p1.id });
    const b = createTicket(store, { key: 'B', title: 'b', projectId: p2.id });
    seedServer(store, a.id, 'web', 'running');
    seedServer(store, b.id, 'api', 'running');

    const rows = listRunningServers(store, p1.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo).toBe('web');
  });

  it('returns all projects when projectId is undefined', () => {
    const p1 = upsertProject(store, { slug: 'p1', name: 'p1' });
    const p2 = upsertProject(store, { slug: 'p2', name: 'p2' });
    const a = createTicket(store, { key: 'A', title: 'a', projectId: p1.id });
    const b = createTicket(store, { key: 'B', title: 'b', projectId: p2.id });
    seedServer(store, a.id, 'web', 'running');
    seedServer(store, b.id, 'api', 'running');

    expect(listRunningServers(store)).toHaveLength(2);
  });

  it('returns a row with a NULL pid as-is', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
         VALUES (?, 'web', 'localhost', 5173, NULL, 'running', '/tmp/x.log')`,
      )
      .run(a.id);

    const row = listRunningServers(store)[0]!;
    expect(row.pid).toBeNull();
  });
});

describe('listTicketLifecycle', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns an empty map for an empty ids array without throwing', () => {
    const map = listTicketLifecycle(store, []);
    expect(map.size).toBe(0);
  });

  it('reports a live ticket as not archived with its stage', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const map = listTicketLifecycle(store, [a.id]);
    expect(map.get(a.id)).toMatchObject({
      key: 'A',
      title: 'a',
      stageCurrent: 'scope',
      archived: false,
    });
  });

  it('reports an archived ticket as archived: true', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare("UPDATE tickets SET archived_at = '2026-08-12T12:00:00.000Z' WHERE id = ?")
      .run(a.id);

    expect(listTicketLifecycle(store, [a.id]).get(a.id)?.archived).toBe(true);
  });

  it('omits ids that do not exist', () => {
    expect(listTicketLifecycle(store, [9999]).size).toBe(0);
  });
});
