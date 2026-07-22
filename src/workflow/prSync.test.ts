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
});
