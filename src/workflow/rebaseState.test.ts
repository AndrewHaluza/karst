import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { transition } from './machine.js';
import { rebaseState } from './rebaseState.js';

let store: Store;
let id: number;

function seedPr(over: { block?: string | null; status?: string; head?: string | null } = {}): void {
  store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, 'r', '/w/r', 'b');
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref, merge_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r', 5, 'https://github.com/o/r/pull/5', over.status ?? 'open',
      over.head === undefined ? 'feat/x' : over.head, 'develop', over.block === undefined ? 'behind' : over.block);
}

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'RB-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
});

describe('rebaseState', () => {
  it('is available for an open PR that is behind', () => {
    seedPr();
    expect(rebaseState(store, id)).toEqual({
      available: true,
      prs: [{ repo: 'r', number: 5, branch: 'feat/x', baseRef: 'develop', cwd: '/w/r' }],
    });
  });
  it('is not-behind when blocked for another reason or unprobed', () => {
    seedPr({ block: 'conflicts' });
    expect(rebaseState(store, id)).toEqual({ available: false, reason: 'not-behind' });
  });
  it('is not-behind without a recorded head branch', () => {
    seedPr({ head: null });
    expect(rebaseState(store, id)).toEqual({ available: false, reason: 'not-behind' });
  });
  it('ignores a merged PR', () => {
    seedPr({ status: 'merged' });
    expect(rebaseState(store, id)).toMatchObject({ available: false });
  });
});

describe('clearOpenPrProbe', () => {
  it('drops the stored rollup and merge block of the open PR', async () => {
    const { clearOpenPrProbe } = await import('../store/prs.js');
    seedPr();
    store.db.prepare(`UPDATE prs SET checks = '{}' WHERE ticket_id = ?`).run(id);
    clearOpenPrProbe(store, id, 'r');
    expect(store.db.prepare('SELECT checks, merge_block FROM prs WHERE ticket_id = ?').get(id)).toEqual({ checks: null, merge_block: null });
  });
});
