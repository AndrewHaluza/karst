import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  listWorktreesByProject,
  listPrsByTicket,
  serverAddress,
} from './dashboard.js';

function seedServer(
  store: Store,
  ticketId: number,
  service: string,
  port: number,
  status: 'running' | 'stopped' = 'running',
): void {
  store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
       VALUES (?, ?, 'localhost', ?, 111, ?, '/tmp/x.log')`,
    )
    .run(ticketId, service, port, status);
}

describe('dashboard store queries', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('listServersByTicket returns only that ticket servers', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    seedServer(store, a.id, 'web', 5173);
    seedServer(store, a.id, 'api', 8000);
    seedServer(store, b.id, 'web', 5174);

    const servers = listServersByTicket(store, a.id);
    expect(servers.map((s) => s.service).sort()).toEqual(['api', 'web']);
    expect(servers.every((s) => s.ticketId === a.id)).toBe(true);
    expect(servers.find((s) => s.service === 'web')!.port).toBe(5173);
  });

  it('serverAddress returns host+port for a running server, null otherwise', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedServer(store, a.id, 'web', 5173, 'running');
    seedServer(store, a.id, 'api', 8000, 'stopped');
    const running = store.db.prepare("SELECT id FROM servers WHERE repo='web'").get() as { id: number };
    const stopped = store.db.prepare("SELECT id FROM servers WHERE repo='api'").get() as { id: number };

    expect(serverAddress(store, running.id)).toEqual({ host: 'localhost', port: 5173 });
    expect(serverAddress(store, stopped.id)).toBeNull(); // not running
    expect(serverAddress(store, 9999)).toBeNull(); // unknown id
  });

  it('excludes graph-agent rows from the services list', () => {
    const other = createTicket(store, { key: 'G-2', title: 'Graph ticket' });
    store.db
      .prepare(
        "INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind) VALUES (?, 'web', 1, 'running', '/wt/web', '2026-08-12T00:00:00.000Z', 'service')",
      )
      .run(other.id);
    store.db
      .prepare(
        "INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind) VALUES (?, 'web', 2, 'running', '/wt/web', '2026-08-12T00:00:00.000Z', 'agent')",
      )
      .run(other.id);
    const servers = listServersByTicket(store, other.id);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.status).toBe('running');
  });

  it('listServersByTicket includes stopped (offline) servers, running first', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedServer(store, a.id, 'web', 5173, 'running');
    seedServer(store, a.id, 'api', 8000, 'stopped'); // offline — retained for restart

    const servers = listServersByTicket(store, a.id);
    expect(servers).toHaveLength(2);
    // running floats to the top, then alphabetical by service
    expect(servers[0]!.service).toBe('web');
    expect(servers[0]!.status).toBe('running');
    expect(servers[1]!.service).toBe('api');
    expect(servers[1]!.status).toBe('stopped');
  });

  it('listWorktreesByTicket returns worktree rows for the ticket', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', '/wt/a', 'karst/a', 'main', 'inherited')`,
      )
      .run(a.id);

    const wts = listWorktreesByTicket(store, a.id);
    expect(wts).toHaveLength(1);
    expect(wts[0]!.path).toBe('/wt/a');
    expect(wts[0]!.branch).toBe('karst/a');
  });

  it('listWorktreesByProject returns worktrees joined with ticket keys, scoped to one project', () => {
    const a = createTicket(store, { key: 'K-1', title: 'a', projectId: 1 });
    const b = createTicket(store, { key: 'K-2', title: 'b', projectId: 2 });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'karst', '/wt/k1', 'karst/a', 'develop', 'inherited')`,
      )
      .run(a.id);
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', '/wt/k2', 'karst/b', 'main', 'inherited')`,
      )
      .run(b.id);

    const rows = listWorktreesByProject(store, a.projectId!);
    expect(rows.map((r) => r.key)).toEqual(['K-1']);
    expect(rows[0]).toMatchObject({ ticketId: a.id, repo: 'karst', path: '/wt/k1', branch: 'karst/a' });
  });

  it('listPrsByTicket returns pr rows for the ticket', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status)
         VALUES (?, 'app', 42, 'http://pr/42', 'open')`,
      )
      .run(a.id);

    const prs = listPrsByTicket(store, a.id);
    expect(prs).toHaveLength(1);
    expect(prs[0]!.number).toBe(42);
    expect(prs[0]!.url).toBe('http://pr/42');
  });

  it('empty ticket returns empty arrays', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    expect(listServersByTicket(store, a.id)).toEqual([]);
    expect(listWorktreesByTicket(store, a.id)).toEqual([]);
    expect(listPrsByTicket(store, a.id)).toEqual([]);
  });
});
