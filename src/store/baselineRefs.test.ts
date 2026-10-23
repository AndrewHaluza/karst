import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { archiveTicket, createTicket } from './tickets.js';
import { setStage } from './stages.js';
import {
  baselineDependentsFor,
  isLiveBaselineDependent,
  listBaselineDependentsDetailed,
} from './baselineRefs.js';

function addRef(store: Store, ticketId: number, repo: string): void {
  store.db
    .prepare('INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)')
    .run(ticketId, repo);
}

function addServer(
  store: Store,
  ticketId: number | null,
  repo: string,
  status = 'running',
): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd)
       VALUES (?, ?, 'localhost', 5173, 4242, ?, '/tmp/x.log', '2026-08-12T10:00:00.000Z', '/tmp/wt/x')`,
    )
    .run(ticketId, repo, status);
  return Number(info.lastInsertRowid);
}

/** Move a ticket to `done`, the one stage whose liveness depends on its servers. */
function makeDone(store: Store, ticketId: number): void {
  setStage(store, ticketId, 'done', { status: 'passed', verdict: 'merged' });
  store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(ticketId);
}

describe('listBaselineDependentsDetailed', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns every ref of the repo with its ticket facts, ordered by ticket id', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const b = createTicket(store, { key: 'B', title: 'b' });
    // Inserted out of order on purpose: the read orders by ticket id.
    addRef(store, b.id, 'api');
    addRef(store, a.id, 'api');
    addServer(store, b.id, 'web', 'running');

    expect(listBaselineDependentsDetailed(store, 'api')).toEqual([
      {
        ticketId: a.id,
        key: 'A',
        title: 'a',
        stageCurrent: 'scope',
        archived: false,
        hasRunningService: false,
      },
      {
        ticketId: b.id,
        key: 'B',
        title: 'b',
        stageCurrent: 'scope',
        archived: false,
        hasRunningService: true,
      },
    ]);
  });

  it('counts only a running SERVICE as a running stack, not a graph agent row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind)
         VALUES (?, 'graph', NULL, NULL, 11, 'running', 'agent')`,
      )
      .run(a.id);

    expect(listBaselineDependentsDetailed(store, 'api')[0]!.hasRunningService).toBe(false);
  });

  it('reports archived as a fact, and excludes a ref whose ticket row is gone', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    addRef(store, 9999, 'api');
    archiveTicket(store, a.id);

    const rows = listBaselineDependentsDetailed(store, 'api');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.archived).toBe(true);
  });

  it('returns [] for a repo with no refs', () => {
    expect(listBaselineDependentsDetailed(store, 'api')).toEqual([]);
  });
});

describe('isLiveBaselineDependent', () => {
  const dep = (over: Partial<Parameters<typeof isLiveBaselineDependent>[0]> = {}) => ({
    ticketId: 1,
    key: 'A',
    title: 'a',
    stageCurrent: 'impl',
    archived: false,
    hasRunningService: false,
    ...over,
  });

  it('counts a non-archived ticket that is not done', () => {
    expect(isLiveBaselineDependent(dep())).toBe(true);
  });

  it('does not count a done ticket whose services are stopped', () => {
    expect(isLiveBaselineDependent(dep({ stageCurrent: 'done' }))).toBe(false);
  });

  it('counts a done ticket that still runs a service — a live stack to break', () => {
    expect(isLiveBaselineDependent(dep({ stageCurrent: 'done', hasRunningService: true }))).toBe(
      true,
    );
  });

  it('never counts an archived ticket, even one still running', () => {
    expect(
      isLiveBaselineDependent(dep({ archived: true, stageCurrent: 'done', hasRunningService: true })),
    ).toBe(false);
  });
});

describe('baselineDependentsFor', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns the live dependents of a baseline row (ticket_id IS NULL)', () => {
    const live = createTicket(store, { key: 'A', title: 'a' });
    const finished = createTicket(store, { key: 'B', title: 'b' });
    const archived = createTicket(store, { key: 'C', title: 'c' });
    addRef(store, live.id, 'api');
    addRef(store, finished.id, 'api');
    addRef(store, archived.id, 'api');
    makeDone(store, finished.id);
    archiveTicket(store, archived.id);
    const baselineId = addServer(store, null, 'api');

    expect(baselineDependentsFor(store, baselineId)).toEqual([
      {
        ticketId: live.id,
        key: 'A',
        title: 'a',
        stageCurrent: 'scope',
        archived: false,
        hasRunningService: false,
      },
    ]);
  });

  it('keeps a done ticket that still runs a service', () => {
    const finished = createTicket(store, { key: 'B', title: 'b' });
    addRef(store, finished.id, 'api');
    makeDone(store, finished.id);
    addServer(store, finished.id, 'web');
    const baselineId = addServer(store, null, 'api');

    expect(baselineDependentsFor(store, baselineId).map((d) => d.key)).toEqual(['B']);
  });

  it('returns [] for a ticket-scoped row and for an id with no row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    const ticketServerId = addServer(store, a.id, 'api');

    expect(baselineDependentsFor(store, ticketServerId)).toEqual([]);
    expect(baselineDependentsFor(store, 9999)).toEqual([]);
  });
});
