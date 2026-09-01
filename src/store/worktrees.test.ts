import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { takeForcePushLease, armForcePushLease } from './worktrees.js';

function seedWorktree(store: Store, ticketId: number, repo: string, needsForcePush: 1 | null): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode, needs_force_push)
       VALUES (?, ?, '/wt', 'karst/x', 'main', 'inherited', ?)`,
    )
    .run(ticketId, repo, needsForcePush);
}

describe('takeForcePushLease', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('answers false and stays false when nothing armed it', () => {
    seedWorktree(store, 1, '/r', null);
    expect(takeForcePushLease(store, 1, '/r')).toBe(false);
    expect(takeForcePushLease(store, 1, '/r')).toBe(false);
  });

  it('answers true exactly once — the flag is consumed, not read', () => {
    seedWorktree(store, 1, '/r', 1);
    expect(takeForcePushLease(store, 1, '/r')).toBe(true);
    expect(takeForcePushLease(store, 1, '/r')).toBe(false);
  });
});

describe('armForcePushLease', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  // A push that consumed the lease and then FAILED (rejected --force-with-lease,
  // dropped connection) must be able to hand the flag back — the branch is
  // still rewritten, so a plain retry push must not be attempted.
  it('re-arms a lease already consumed, so the next take succeeds', () => {
    seedWorktree(store, 1, '/r', 1);
    expect(takeForcePushLease(store, 1, '/r')).toBe(true);
    // The push using this taken lease failed; re-arm it.
    armForcePushLease(store, 1, '/r');
    expect(takeForcePushLease(store, 1, '/r')).toBe(true);
  });
});
