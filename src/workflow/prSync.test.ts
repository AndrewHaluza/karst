import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listPrsByTicket } from '../store/dashboard.js';
import { listPrFeedback } from '../store/prFeedback.js';
import type { GhRunner } from '../integrations/github.js';
import type { PrFeedbackProbe } from '../integrations/githubReview.js';
import type { PrReviewThread } from '../model/prReview.js';
import { syncPrStatuses } from './prSync.js';

function seedPr(store: Store, ticketId: number, repo: string, number: number, status: string): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, status);
}

function seedWorktree(store: Store, ticketId: number, repo: string, path: string): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, `karst/${repo}`, 'main');
}

/** A gh that answers `pr view` with the given state keyed by the ref (url) asked. */
function ghReturning(byRef: Record<string, { state: string; isDraft?: boolean }>): GhRunner {
  return async (args) => {
    const ref = args[2]!;
    const v = byRef[ref];
    if (!v) return { stdout: '', exitCode: 1, stderr: 'not found' };
    return { stdout: JSON.stringify({ state: v.state, isDraft: v.isDraft ?? false }), exitCode: 0 };
  };
}

const PR12 = 'https://github.com/o/r/pull/12';

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    nodeId: 'PRRT_1',
    upstreamKey: '1001',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 10,
    startLine: null,
    originalLine: 10,
    originalCommitId: 'abc',
    subjectType: 'LINE',
    author: { login: 'ada', typeName: 'User', association: 'MEMBER' },
    body: 'please fix this',
    comments: [],
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function probe(threads: PrReviewThread[]): PrFeedbackProbe {
  return {
    snapshot: { decision: null, reviews: [], threads },
    truncated: { threads: false, reviews: false, threadComments: [] },
  };
}

describe('syncPrStatuses', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('corrects a PR stuck on open once it has merged upstream', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const changed = await syncPrStatuses(store, ghReturning({ [PR12]: { state: 'MERGED' } }), { projectId: 1 });

    expect(changed).toBe(1);
    expect(listPrsByTicket(store, a.id)[0]!.status).toBe('merged');
  });

  it('reflects a reopened (closed → open) PR', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'closed');
    seedWorktree(store, a.id, 'api', '/wt/api');

    await syncPrStatuses(store, ghReturning({ [PR12]: { state: 'OPEN' } }), { projectId: 1 });

    expect(listPrsByTicket(store, a.id)[0]!.status).toBe('open');
  });

  // Graceful degradation: when gh cannot see the PR, the last known status must
  // survive — never clobbered to 'unknown'. And a probe failure must not count as
  // a change (no needless dashboard refresh).
  it('keeps the last known status when gh cannot determine the state', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const changed = await syncPrStatuses(store, ghReturning({}), { projectId: 1 });

    expect(changed).toBe(0);
    expect(listPrsByTicket(store, a.id)[0]!.status).toBe('open');
  });

  it('does not report a change when the status is already current', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const changed = await syncPrStatuses(store, ghReturning({ [PR12]: { state: 'OPEN' } }), { projectId: 1 });

    expect(changed).toBe(0);
  });

  // One dead probe must not sink the rest of the sweep — the other PRs still get
  // their real status.
  it('keeps syncing the other PRs when one probe throws', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedPr(store, a.id, 'web', 34, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    seedWorktree(store, a.id, 'web', '/wt/web');

    const gh: GhRunner = async (args) => {
      if (args[2] === PR12) throw new Error('boom');
      return { stdout: JSON.stringify({ state: 'MERGED', isDraft: false }), exitCode: 0 };
    };

    const changed = await syncPrStatuses(store, gh, { projectId: 1 });

    expect(changed).toBe(1);
    const prs = listPrsByTicket(store, a.id);
    expect(prs.find((p) => p.repo === 'api')!.status).toBe('open'); // untouched by the throw
    expect(prs.find((p) => p.repo === 'web')!.status).toBe('merged');
  });
  it('fills in the PR metadata the ship stage renders', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const gh: GhRunner = async () => ({
      stdout: JSON.stringify({
        state: 'MERGED',
        isDraft: false,
        headRefName: 'karst/feat/x',
        baseRefName: 'develop',
        createdAt: '2026-07-23T08:00:00Z',
        mergedAt: '2026-07-28T09:30:00Z',
        comments: [{ author: { login: 'ada' }, createdAt: '2026-07-24T10:00:00Z', body: 'lgtm' }],
      }),
      exitCode: 0,
    });

    const changed = await syncPrStatuses(store, gh, { projectId: 1 });

    expect(changed).toBe(1);
    expect(listPrsByTicket(store, a.id)[0]).toMatchObject({
      status: 'merged',
      headRef: 'karst/feat/x',
      baseRef: 'develop',
      createdAt: '2026-07-23T08:00:00Z',
      mergedAt: '2026-07-28T09:30:00Z',
      comments: [{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'lgtm' }],
    });
  });

  // Metadata moves on its own: a new comment on a PR that is still open is a real
  // change the panel must be refreshed for, even though the status did not move.
  it('reports a change when only the metadata moved', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const withComments = (n: number): GhRunner => async () => ({
      stdout: JSON.stringify({
        state: 'OPEN',
        isDraft: false,
        headRefName: 'karst/feat/x',
        baseRefName: 'develop',
        createdAt: '2026-07-23T08:00:00Z',
        mergedAt: null,
        comments: Array.from({ length: n }, (_, i) => ({ body: `c${i}` })),
      }),
      exitCode: 0,
    });

    expect(await syncPrStatuses(store, withComments(1), { projectId: 1 })).toBe(1);
    // Same answer twice: nothing moved, so no refresh is asked for.
    expect(await syncPrStatuses(store, withComments(1), { projectId: 1 })).toBe(0);
    expect(await syncPrStatuses(store, withComments(2), { projectId: 1 })).toBe(1);
    expect(listPrsByTicket(store, a.id)[0]!.comments).toHaveLength(2);
  });

  // Graceful degradation applies to metadata too: an older gh that answers with
  // fewer fields must not erase branches and dates a previous sweep learned.
  it('keeps stored metadata when a later probe stops reporting it', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const rich: GhRunner = async () => ({
      stdout: JSON.stringify({
        state: 'OPEN',
        isDraft: false,
        headRefName: 'karst/feat/x',
        baseRefName: 'develop',
        createdAt: '2026-07-23T08:00:00Z',
        comments: [],
      }),
      exitCode: 0,
    });
    await syncPrStatuses(store, rich, { projectId: 1 });

    const bare: GhRunner = async () => ({
      stdout: JSON.stringify({ state: 'CLOSED' }),
      exitCode: 0,
    });
    await syncPrStatuses(store, bare, { projectId: 1 });

    const pr = listPrsByTicket(store, a.id)[0]!;
    expect(pr.status).toBe('closed');
    expect(pr.headRef).toBe('karst/feat/x');
    expect(pr.baseRef).toBe('develop');
    expect(pr.createdAt).toBe('2026-07-23T08:00:00Z');
  });
});

describe('syncPrStatuses feedback refresh', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('lands feedback rows when a fetcher is injected', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const changed = await syncPrStatuses(
      store,
      ghReturning({ [PR12]: { state: 'MERGED' } }),
      { projectId: 1 },
      { fetchFeedback: async () => probe([thread()]), now: () => '2026-09-15T00:00:00Z' },
    );

    expect(changed).toBe(2);
    expect(listPrFeedback(store, a.id)).toHaveLength(1);
    expect(listPrFeedback(store, a.id)[0]!.body).toBe('please fix this');
  });

  it('refreshes feedback even when the PR detail did not change', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const changed = await syncPrStatuses(
      store,
      ghReturning({ [PR12]: { state: 'OPEN' } }),
      { projectId: 1 },
      { fetchFeedback: async () => probe([thread()]), now: () => '2026-09-15T00:00:00Z' },
    );

    expect(changed).toBe(1);
    expect(listPrFeedback(store, a.id)).toHaveLength(1);
  });

  it('refreshes feedback even when the detail probe threw', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const gh: GhRunner = async () => {
      throw new Error('boom');
    };
    const changed = await syncPrStatuses(store, gh, { projectId: 1 }, {
      fetchFeedback: async () => probe([thread()]),
      now: () => '2026-09-15T00:00:00Z',
    });

    expect(changed).toBe(1);
    expect(listPrFeedback(store, a.id)).toHaveLength(1);
  });

  it('writes nothing when the fetcher returns null', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const changed = await syncPrStatuses(
      store,
      ghReturning({ [PR12]: { state: 'OPEN' } }),
      { projectId: 1 },
      { fetchFeedback: async () => null, now: () => '2026-09-15T00:00:00Z' },
    );

    expect(changed).toBe(0);
    expect(listPrFeedback(store, a.id)).toHaveLength(0);
  });

  it('keeps going when one fetcher throws', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedPr(store, a.id, 'web', 34, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');
    seedWorktree(store, a.id, 'web', '/wt/web');

    const changed = await syncPrStatuses(
      store,
      ghReturning({ [PR12]: { state: 'OPEN' }, 'https://github.com/o/r/pull/34': { state: 'OPEN' } }),
      { projectId: 1 },
      {
        fetchFeedback: async (ref) => {
          if (ref.number === 12) throw new Error('boom');
          return probe([thread({ upstreamKey: '2001', body: 'web ask' })]);
        },
        now: () => '2026-09-15T00:00:00Z',
      },
    );

    expect(changed).toBe(1);
    const rows = listPrFeedback(store, a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('web ask');
  });

  it('skips an unparseable url without throwing or fetching', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, 'api', 12, 'https://gitlab.com/o/r/merge_requests/12', 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const gh: GhRunner = async () => ({ stdout: JSON.stringify({ state: 'OPEN' }), exitCode: 0 });
    let fetched = false;
    const changed = await syncPrStatuses(store, gh, { projectId: 1 }, {
      fetchFeedback: async () => {
        fetched = true;
        return probe([thread()]);
      },
    });

    expect(changed).toBe(0);
    expect(fetched).toBe(false);
    expect(listPrFeedback(store, a.id)).toHaveLength(0);
  });

  it('logs one [merge] line when the probe was truncated', async () => {
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    const debugs: string[] = [];
    await syncPrStatuses(
      store,
      ghReturning({ [PR12]: { state: 'OPEN' } }),
      { projectId: 1 },
      {
        fetchFeedback: async () => ({
          snapshot: { decision: null, reviews: [], threads: [thread()] },
          truncated: { threads: true, reviews: false, threadComments: [] },
        }),
        now: () => '2026-09-15T00:00:00Z',
        debug: (m) => debugs.push(m),
      },
    );

    const truncation = debugs.filter((m) => m.includes('TRUNCATED'));
    expect(truncation).toHaveLength(1);
    expect(truncation[0]).toContain('[merge]');
    expect(truncation[0]).toContain('api');
  });

  it('does not mark rows absent when the threads list was truncated', async () => {
    // A truncated probe is an INCOMPLETE set: a row it did not carry was
    // unread, not withdrawn, so it must not be stamped absent.
    const a = createTicket(store, { key: 'A', title: 'a', projectId: 1 });
    seedPr(store, a.id, 'api', 12, 'open');
    seedWorktree(store, a.id, 'api', '/wt/api');

    await syncPrStatuses(store, ghReturning({ [PR12]: { state: 'OPEN' } }), { projectId: 1 }, {
      fetchFeedback: async () =>
        probe([thread({ upstreamKey: '1' }), thread({ upstreamKey: '2', nodeId: 'PRRT_2' })]),
      now: () => '2026-09-15T00:00:00Z',
    });
    expect(listPrFeedback(store, a.id)).toHaveLength(2);

    await syncPrStatuses(store, ghReturning({ [PR12]: { state: 'OPEN' } }), { projectId: 1 }, {
      fetchFeedback: async () => ({
        snapshot: { decision: null, reviews: [], threads: [thread({ upstreamKey: '1' })] },
        truncated: { threads: true, reviews: false, threadComments: [] },
      }),
      now: () => '2026-09-16T00:00:00Z',
    });

    const rows = listPrFeedback(store, a.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.absentAt === null)).toBe(true);
  });
});
