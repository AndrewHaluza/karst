import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listPrsByTicket } from '../store/dashboard.js';
import type { GhRunner } from '../integrations/github.js';
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
