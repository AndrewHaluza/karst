import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { takeForcePushLease } from './worktrees.js';

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
