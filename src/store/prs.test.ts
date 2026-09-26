import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { listPrsByTicket } from './dashboard.js';
import {
  updatePrStatus,
  updatePrDetail,
  findTicketPr,
  listSyncablePrs,
  recordShippedPr,
  dismissPr,
  undismissPr,
  listCurrentPrsByTicket,
} from './prs.js';

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

  // A repo can hold several worktrees (a re-spin cut a second checkout). The
  // grouped column must name ONE of them deterministically — the newest — so gh
  // never runs in a stale/pruned checkout and the PR keeps re-probing (P2-11).
  it('chooses the newest worktree of a repo deterministically (P2-11)', () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    // The stale checkout is inserted FIRST (lower rowid) and sorts FIRST by
    // path — the row the old bare grouped column resolved to under the plan
    // (`SEARCH w USING INDEX idx_worktrees_ticket_path`).
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'api', '/wt/aa-old', 'karst/api', 'release');
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'api', '/wt/zz-new', 'karst/api', 'develop');

    const rows = listSyncablePrs(store, { projectId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cwd: '/wt/zz-new', baseRef: 'develop' });
  });
});

describe('updatePrDetail', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const url = (n: number) => `https://github.com/o/r/pull/${n}`;

  it('writes the status and every metadata field for the matching PR only', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    seedPr(store, a.id, 'web', 34, 'open');

    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: {
        status: 'merged',
        headRef: 'karst/feat/x',
        baseRef: 'develop',
        createdAt: '2026-07-23T08:00:00Z',
        mergedAt: '2026-07-28T09:30:00Z',
        comments: [{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'lgtm' }],
        checks: null,
        mergeBlock: 'unknown',
      },
    });

    const prs = listPrsByTicket(store, a.id);
    expect(prs.find((p) => p.repo === 'api')).toMatchObject({
      status: 'merged',
      headRef: 'karst/feat/x',
      baseRef: 'develop',
      createdAt: '2026-07-23T08:00:00Z',
      mergedAt: '2026-07-28T09:30:00Z',
      comments: [{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'lgtm' }],
    });
    const other = prs.find((p) => p.repo === 'web')!;
    expect(other.status).toBe('open');
    expect(other.headRef).toBeNull();
  });

  // The whole point of the three-valued fields: a probe that saw less than last
  // time must not erase what karst already knows.
  it('keeps a stored field when the new detail states null for it', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: {
        status: 'open',
        headRef: 'karst/feat/x',
        baseRef: 'develop',
        createdAt: '2026-07-23T08:00:00Z',
        mergedAt: null,
        comments: [{ author: 'ada', at: null, body: 'lgtm' }],
        checks: null,
        mergeBlock: 'unknown',
      },
    });

    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: {
        status: 'closed',
        headRef: null,
        baseRef: null,
        createdAt: null,
        mergedAt: null,
        comments: null,
        checks: null,
        mergeBlock: 'unknown',
      },
    });

    const pr = listPrsByTicket(store, a.id)[0]!;
    expect(pr.status).toBe('closed'); // the status it DID report still lands
    expect(pr.headRef).toBe('karst/feat/x');
    expect(pr.baseRef).toBe('develop');
    expect(pr.createdAt).toBe('2026-07-23T08:00:00Z');
    expect(pr.comments).toEqual([{ author: 'ada', at: null, body: 'lgtm' }]);
  });

  // [] is a real answer: a thread whose only comment was deleted upstream must
  // stop showing it.
  it('clears comments when the probe reports an empty list', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    const base = {
      status: 'open' as const,
      headRef: null,
      baseRef: null,
      createdAt: null,
      mergedAt: null,
      checks: null,
      mergeBlock: 'unknown' as const,
    };
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: { ...base, comments: [{ author: 'ada', at: null, body: 'gone soon' }] },
    });
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: { ...base, comments: [] },
    });
    expect(listPrsByTicket(store, a.id)[0]!.comments).toEqual([]);
  });

  it('never writes an unknown status over a real one', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: {
        status: 'unknown',
        headRef: 'karst/feat/x',
        baseRef: null,
        createdAt: null,
        mergedAt: null,
        comments: null,
        checks: null,
        mergeBlock: 'unknown',
      },
    });
    const pr = listPrsByTicket(store, a.id)[0]!;
    expect(pr.status).toBe('open');
    // Metadata it could still state is not thrown away with the status.
    expect(pr.headRef).toBe('karst/feat/x');
  });

  const passing = {
    state: 'passing' as const,
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    failing: [],
    failedShown: 0,
  };

  it('writes the CI rollup and reads it back as the serialized column', () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: {
        status: 'open',
        headRef: null,
        baseRef: null,
        createdAt: null,
        mergedAt: null,
        comments: null,
        checks: passing,
        mergeBlock: 'clean',
      },
    });
    const row = listSyncablePrs(store, { projectId: 1 })[0]!;
    expect(row.prChecks).toBe(JSON.stringify(passing));
    expect(row.prMergeBlock).toBe('clean');
  });

  it('keeps a stored rollup when a later probe reports no checks', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    const detail = {
      status: 'open' as const,
      headRef: null,
      baseRef: null,
      createdAt: null,
      mergedAt: null,
      comments: null,
      checks: passing,
      mergeBlock: 'clean' as const,
    };
    updatePrDetail(store, { ticketId: a.id, repo: 'api', url: url(12), detail });
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: { ...detail, checks: null },
    });
    expect(listPrsByTicket(store, a.id)[0]!.checks).toEqual(passing);
  });

  it('keeps a stored block when a later probe answers unknown', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    const detail = {
      status: 'open' as const,
      headRef: null,
      baseRef: null,
      createdAt: null,
      mergedAt: null,
      comments: null,
      checks: null,
      mergeBlock: 'blocked' as const,
    };
    updatePrDetail(store, { ticketId: a.id, repo: 'api', url: url(12), detail });
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: { ...detail, mergeBlock: 'unknown' },
    });
    expect(listPrsByTicket(store, a.id)[0]!.mergeBlock).toBe('blocked');
  });

  it('overwrites a stored block when GitHub says the merge is clean again', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    const detail = {
      status: 'open' as const,
      headRef: null,
      baseRef: null,
      createdAt: null,
      mergedAt: null,
      comments: null,
      checks: null,
      mergeBlock: 'blocked' as const,
    };
    updatePrDetail(store, { ticketId: a.id, repo: 'api', url: url(12), detail });
    updatePrDetail(store, {
      ticketId: a.id,
      repo: 'api',
      url: url(12),
      detail: { ...detail, mergeBlock: 'clean' },
    });
    expect(listPrsByTicket(store, a.id)[0]!.mergeBlock).toBe('clean');
  });
});

describe('findTicketPr', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('resolves one repo’s PR with the worktree to run gh in', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    expect(findTicketPr(store, a.id, 'api')).toMatchObject({
      repo: 'api',
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      status: 'open',
      cwd: '/wt/api',
    });
  });

  it('is null for a repo with no PR, and for a PR with no url to act on', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedWorktree(store, a.id, 'api', '/wt/api');
    expect(findTicketPr(store, a.id, 'api')).toBeNull();
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'api', 12, null, 'open');
    expect(findTicketPr(store, a.id, 'api')).toBeNull();
  });

  // Without a worktree there is nowhere to run gh — the same graceful skip
  // `listSyncablePrs` makes for an archived ticket.
  it('is null when the worktree is gone (archived ticket)', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, a.id, 'api', 12, 'open');
    expect(findTicketPr(store, a.id, 'api')).toBeNull();
  });
});

describe('recordShippedPr', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('inserts a fresh row when none exists for (ticket, repo, url)', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    recordShippedPr(store, {
      ticketId: a.id,
      repo: 'api',
      number: 12,
      url: 'https://github.com/o/r/pull/12',
    });
    const prs = listPrsByTicket(store, a.id);
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(12);
  });

  // Defect 3: this is what the plain INSERT in ship.ts used to do — call it
  // twice for the same PR and it must update the ONE row, never create a
  // second one, however the row's status changed in between (open -> draft is
  // exactly what `updatePrDetail` does right after ship creates a PR).
  it('updates the existing row instead of inserting a duplicate, however its status changed', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const url = 'https://github.com/o/r/pull/3461';
    recordShippedPr(store, { ticketId: a.id, repo: 'api', number: 3461, url });
    updatePrStatus(store, { ticketId: a.id, repo: 'api', url, status: 'draft' });

    // A re-ship re-adopts the same PR (findOpenPr) and records it again.
    recordShippedPr(store, { ticketId: a.id, repo: 'api', number: 3461, url });

    const prs = listPrsByTicket(store, a.id);
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(3461);
  });

  // F4: a status already probed from GitHub is a real answer. Re-recording a
  // PR ship merely re-adopted must not downgrade 'draft' back to a guessed
  // 'open' — the `fetchPrDetail` probe that follows may fail, and its
  // 'unknown' is dropped rather than stored, so the guess would stick.
  it('keeps the stored status when it updates an existing row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    const url = 'https://github.com/o/r/pull/3461';
    recordShippedPr(store, { ticketId: a.id, repo: 'api', number: 3461, url });
    updatePrStatus(store, { ticketId: a.id, repo: 'api', url, status: 'draft' });

    recordShippedPr(store, { ticketId: a.id, repo: 'api', number: 3461, url });

    expect(listPrsByTicket(store, a.id)[0]?.status).toBe('draft');
  });

  it('keys on (ticket_id, repo, url) — a different repo or url is a different row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    recordShippedPr(store, {
      ticketId: a.id,
      repo: 'api',
      number: 1,
      url: 'https://github.com/o/r/pull/1',
    });
    recordShippedPr(store, {
      ticketId: a.id,
      repo: 'web',
      number: 2,
      url: 'https://github.com/o/r/pull/2',
    });
    expect(listPrsByTicket(store, a.id)).toHaveLength(2);
  });
});

describe('dismissPr', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('stamps the repo current PR as dismissed and reports it', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, t.id, 'api', 12, 'closed');

    const ok = dismissPr(store, { ticketId: t.id, repo: 'api', at: '2026-09-06T10:00:00Z' });

    expect(ok).toBe(true);
    expect(listCurrentPrsByTicket(store, t.id)[0]!.dismissedAt).toBe('2026-09-06T10:00:00Z');
  });

  it('leaves other repos alone and reports false when the repo has no PR', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, t.id, 'api', 12, 'closed');

    expect(dismissPr(store, { ticketId: t.id, repo: 'web', at: '2026-09-06T10:00:00Z' })).toBe(false);
    expect(listCurrentPrsByTicket(store, t.id)[0]!.dismissedAt).toBeNull();
  });

  it('refuses to dismiss a merged PR — a landed PR is not abandoned work', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, t.id, 'api', 12, 'merged');

    expect(dismissPr(store, { ticketId: t.id, repo: 'api', at: '2026-09-06T10:00:00Z' })).toBe(false);
    expect(listCurrentPrsByTicket(store, t.id)[0]!.dismissedAt).toBeNull();
  });

  it('undismisses, so a PR reopened upstream can block the gate again', () => {
    const t = createTicket(store, { key: 'A', title: 'a' });
    seedPr(store, t.id, 'api', 12, 'closed');
    dismissPr(store, { ticketId: t.id, repo: 'api', at: '2026-09-06T10:00:00Z' });

    expect(undismissPr(store, { ticketId: t.id, repo: 'api' })).toBe(true);
    expect(listCurrentPrsByTicket(store, t.id)[0]!.dismissedAt).toBeNull();
  });
});
