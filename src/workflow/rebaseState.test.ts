import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, setAgentState } from '../store/tickets.js';
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

describe('rebaseState pre-ship', () => {
  function seedWt(): void {
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)').run(id, 'r', '/w/r', 'b', 'develop');
  }
  function toStage(stage: 'impl' | 'uat' | 'review' | 'fix'): void {
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, id);
  }

  it.each(['impl', 'uat', 'review', 'fix'] as const)('is available at %s for a spun ticket', (stage) => {
    seedWt();
    toStage(stage);
    expect(rebaseState(store, id)).toEqual({
      available: true,
      prs: [{ repo: 'r', number: null, branch: 'b', baseRef: 'develop', cwd: '/w/r', preShip: true }],
    });
  });
  it('carries the open PR number at fix', () => {
    seedWt();
    seedPrRow();
    toStage('fix');
    expect(rebaseState(store, id)).toMatchObject({ available: true, prs: [{ number: 5 }] });
  });
  it('is not-spun without worktrees', () => {
    toStage('uat');
    expect(rebaseState(store, id)).toEqual({ available: false, reason: 'not-spun' });
  });
  it('is refused while an agent turn runs', () => {
    seedWt();
    toStage('fix');
    setAgentState(store, id, 'running');
    expect(rebaseState(store, id)).toEqual({ available: false, reason: 'in-flight' });
  });
  it('is refused once a PR merged', () => {
    seedWt();
    seedPrRow('merged');
    toStage('uat');
    expect(rebaseState(store, id)).toEqual({ available: false, reason: 'landed' });
  });
  it('is refused at scope and done', () => {
    seedWt();
    for (const st of ['scope', 'done']) {
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(st, id);
      expect(rebaseState(store, id)).toMatchObject({ available: false, reason: 'stage' });
    }
  });
});

function seedPrRow(status = 'open'): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'r', 5, 'https://github.com/o/r/pull/5', status, 'b', 'develop');
}
