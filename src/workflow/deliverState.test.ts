import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { transition } from './machine.js';
import { deliverTargets } from './deliverState.js';

let store: Store;
let id: number;

function seed(over: { status?: string; head?: string | null; worktree?: boolean } = {}): void {
  if (over.worktree !== false) store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
  store.db.prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref) VALUES (?, ?, 5, ?, ?, ?, ?)')
    .run(id, 'r', 'https://github.com/o/r/pull/5', over.status ?? 'open', over.head === undefined ? 'feat/x' : over.head, 'develop');
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'W-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
});

describe('deliverTargets', () => {
  it('lists the open PR with its head branch and worktree', () => {
    seed();
    expect(deliverTargets(store, id)).toEqual({ available: true, prs: [{ repo: 'r', number: 5, branch: 'feat/x', cwd: '/w/r' }] });
  });
  it('is unavailable without an open PR', () => {
    expect(deliverTargets(store, id)).toEqual({ available: false, reason: 'no-open-pr' });
    seed({ status: 'closed' });
    expect(deliverTargets(store, id)).toEqual({ available: false, reason: 'no-open-pr' });
  });
  it('skips a PR with no head branch or no worktree', () => {
    seed({ head: null });
    expect(deliverTargets(store, id).available).toBe(false);
  });
  it('is unavailable outside ship', () => {
    seed();
    store.db.prepare(`UPDATE tickets SET stage_current = 'impl' WHERE id = ?`).run(id);
    expect(deliverTargets(store, id).available).toBe(false);
  });
});
