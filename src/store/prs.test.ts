import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { listPrsByTicket } from './dashboard.js';
import { updatePrStatus, listSyncablePrs } from './prs.js';

function seedPr(
  store: Store,
  ticketId: number,
  repo: string,
  number: number,
  status: string | null,
): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, status);
}

function seedWorktree(store: Store, ticketId: number, repo: string, path: string): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, `karst/${repo}`, 'main');
}

describe('updatePrStatus', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('overwrites the stored status for the matching PR only', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    seedPr(store, a.id, 'web', 34, 'open');

    updatePrStatus(store, { ticketId: a.id, repo: 'api', url: 'https://github.com/o/r/pull/12', status: 'merged' });

    const prs = listPrsByTicket(store, a.id);
    expect(prs.find((p) => p.repo === 'api')!.status).toBe('merged');
    expect(prs.find((p) => p.repo === 'web')!.status).toBe('open');
  });
});

describe('listSyncablePrs', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns non-merged PRs with the worktree cwd to probe from', () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const rows = listSyncablePrs(store, { projectId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticketId: a.id,
      repo: 'api',
      url: 'https://github.com/o/r/pull/12',
      status: 'open',
      cwd: '/wt/api',
    });
  });

  // Merged is terminal — it cannot change again, so re-querying it is wasted gh
  // calls. Closed is NOT terminal: a closed PR can be reopened upstream, so it
  // must keep syncing.
  it('skips merged PRs but keeps closed ones (a closed PR can reopen)', () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 1, 'merged');
    seedPr(store, a.id, 'web', 2, 'closed');
    seedWorktree(store, a.id, 'api', '/wt/api');
    seedWorktree(store, a.id, 'web', '/wt/web');

    const rows = listSyncablePrs(store, { projectId: 1 });
    expect(rows.map((r) => r.repo)).toEqual(['web']);
  });

  // A window must never sync another project's PRs — same scoping rule as every
  // other ticket query (projects invariant).
  it('is scoped to the project', () => {
    const mine = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    const other = createTicket(store, { key: 'B', title: 'b', projectId: 2 });
    seedPr(store, mine.id, 'api', 1, 'open');
    seedPr(store, other.id, 'api', 2, 'open');
    seedWorktree(store, mine.id, 'api', '/wt/mine');
    seedWorktree(store, other.id, 'api', '/wt/other');

    const rows = listSyncablePrs(store, { projectId: 1 });
    expect(rows.map((r) => r.cwd)).toEqual(['/wt/mine']);
  });

  // No url means nothing to query, and no worktree means nowhere to run gh — both
  // are unsyncable, and returning them would only make the driver skip them
  // anyway. Filter at the source.
  it('excludes PRs with no url and PRs with no worktree', () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, NULL, ?)')
      .run(a.id, 'api', 1, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    seedPr(store, a.id, 'web', 2, 'open'); // has url, no worktree

    const rows = listSyncablePrs(store, { projectId: 1 });
    expect(rows).toHaveLength(0);
  });
});
