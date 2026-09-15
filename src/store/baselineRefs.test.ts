import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { baselineDependentsFor, listBaselineDependents } from './baselineRefs.js';

function addRef(store: Store, ticketId: number, repo: string): void {
  store.db
    .prepare('INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)')
    .run(ticketId, repo);
}

function addServer(store: Store, ticketId: number | null, repo: string): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd)
       VALUES (?, ?, 'localhost', 5173, 4242, 'running', '/tmp/x.log', '2026-08-12T10:00:00.000Z', '/tmp/wt/x')`,
    )
    .run(ticketId, repo);
  return Number(info.lastInsertRowid);
}

describe('listBaselineDependents', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns the ticket ids for a repo, ascending', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    addRef(store, b.id, 'api');
    addRef(store, a.id, 'api');

    expect(listBaselineDependents(store, 'api')).toEqual([a.id, b.id].sort((x, y) => x - y));
  });

  it('returns [] for a repo with no refs', () => {
    expect(listBaselineDependents(store, 'api')).toEqual([]);
  });

  it('excludes a ref whose ticket row no longer exists', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    addRef(store, 9999, 'api');

    expect(listBaselineDependents(store, 'api')).toEqual([a.id]);
  });
});

describe('baselineDependentsFor', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns the dependents for a baseline row (ticket_id IS NULL)', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    const baselineId = addServer(store, null, 'api');

    expect(baselineDependentsFor(store, baselineId)).toEqual([a.id]);
  });

  it('returns [] for a ticket-scoped row and for an id with no row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    const ticketServerId = addServer(store, a.id, 'api');

    expect(baselineDependentsFor(store, ticketServerId)).toEqual([]);
    expect(baselineDependentsFor(store, 9999)).toEqual([]);
  });
});
