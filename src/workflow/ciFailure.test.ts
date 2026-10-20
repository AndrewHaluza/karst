import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { transition } from './machine.js';
import { ciFailureState } from './ciFailure.js';
import { sendBackToImplement } from './sendBack.js';
import { listInbox } from '../store/ticketMessages.js';

let store: Store;
let id: number;

function seedPr(over: { checks?: unknown; status?: string; number?: number; repo?: string } = {}): void {
  const repo = over.repo ?? 'r';
  const n = over.number ?? 5;
  if (!store.db.prepare('SELECT 1 FROM worktrees WHERE ticket_id = ? AND repo = ?').get(id, repo)) {
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(id, repo, '/w/' + repo, 'b');
  }
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status, checks) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, repo, n, `https://github.com/o/r/pull/${n}`, over.status ?? 'open',
      over.checks === undefined ? null : JSON.stringify(over.checks));
}
const failing = { state: 'failing', total: 2, passed: 1, failed: 1, pending: 0, failedShown: 1,
  failing: [{ name: 'build', url: 'https://github.com/o/r/actions/runs/1/job/2' }] };

beforeEach(() => {
  store = openStore(':memory:');
  id = createTicket(store, { key: 'CI-1', title: 't' }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
});

describe('ciFailureState', () => {
  it('is available with the failing checks when a current open PR is failing', () => {
    seedPr({ checks: failing });
    const s = ciFailureState(store, id);
    expect(s).toMatchObject({ available: true });
    if (s.available) expect(s.prs[0]).toMatchObject({ repo: 'r', number: 5, cwd: '/w/r', failing: failing.failing });
  });
  it('is not-failing when passing or never probed', () => {
    seedPr({ checks: { ...failing, state: 'passing', failing: [] } });
    expect(ciFailureState(store, id)).toEqual({ available: false, reason: 'not-failing' });
  });
  it('is disabled while another open PR is pending', () => {
    seedPr({ checks: failing });
    seedPr({ repo: 'r2', number: 6, checks: { ...failing, state: 'pending', failing: [] } });
    expect(ciFailureState(store, id)).toEqual({ available: false, reason: 'pending' });
  });
  it('ignores merged PRs and defers to sendBackState outside ship', () => {
    seedPr({ checks: failing, status: 'merged' });
    expect(ciFailureState(store, id)).toMatchObject({ available: false });
  });
});

describe('sendBackToImplement reason', () => {
  it('posts the reason as a host event to the ticket in the same move', () => {
    sendBackToImplement(store, id, { reason: 'CI failed: build' });
    const msgs = listInbox(store, id, { unreadOnly: false });
    expect(msgs.map((m) => [m.kind, m.fromTicketId, m.body])).toEqual([['event', null, 'CI failed: build']]);
  });
  it('a refused send-back posts nothing', () => {
    sendBackToImplement(store, id);
    expect(() => sendBackToImplement(store, id, { reason: 'x' })).toThrow(/refused/);
    expect(listInbox(store, id, { unreadOnly: false })).toHaveLength(0);
  });
});
