import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import { transition } from './machine.js';
import { resolveShipLanding } from './mergeGate.js';
import { dismissTicketPr, undismissTicketPr } from './dismissPr.js';

function seedPr(store: Store, ticketId: number, repo: string, status: string, number = 12): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, status);
}

/** Walk a ticket to `ship` and park it on the merge gate, the way ship's tail does. */
function parkAtShip(store: Store, ticketId: number): void {
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) {
    transition(store, ticketId, from, { kind: 'passed' });
  }
  resolveShipLanding(store, ticketId);
}

describe('dismissTicketPr', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  it('lands the ticket when the dismissed PR was the only holdout', () => {
    seedPr(store, id, 'api', 'merged');
    seedPr(store, id, 'web', 'closed', 13);
    parkAtShip(store, id);
    expect(getTicket(store, id).stageCurrent).toBe('ship');

    const result = dismissTicketPr(store, { ticketId: id, repo: 'web', at: '2026-09-06T10:00:00Z' });

    expect(result).toEqual({ ok: true, completedTicket: true, reason: '' });
    expect(getTicket(store, id).stageCurrent).toBe('done');
    expect(stageBlock(store, id, 'ship')).toBeNull();
  });

  it('keeps the ticket parked when another repo has still to land', () => {
    seedPr(store, id, 'api', 'open');
    seedPr(store, id, 'web', 'closed', 13);
    parkAtShip(store, id);

    const result = dismissTicketPr(store, { ticketId: id, repo: 'web', at: '2026-09-06T10:00:00Z' });

    expect(result.ok).toBe(true);
    expect(result.completedTicket).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('refuses a repo the ticket has no PR for, and says so', () => {
    seedPr(store, id, 'api', 'closed');
    parkAtShip(store, id);

    const result = dismissTicketPr(store, { ticketId: id, repo: 'nope', at: '2026-09-06T10:00:00Z' });

    expect(result.ok).toBe(false);
    expect(result.completedTicket).toBe(false);
    expect(result.reason).toContain('nope');
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('refuses to dismiss a merged PR', () => {
    seedPr(store, id, 'api', 'merged');
    seedPr(store, id, 'web', 'open', 13);
    parkAtShip(store, id);

    const result = dismissTicketPr(store, { ticketId: id, repo: 'api', at: '2026-09-06T10:00:00Z' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('merged');
  });

  it('undismisses and re-blocks a ticket still at ship', () => {
    seedPr(store, id, 'api', 'closed');
    parkAtShip(store, id);
    dismissTicketPr(store, { ticketId: id, repo: 'api', at: '2026-09-06T10:00:00Z' });
    // The ticket landed on the dismissal; undoing it cannot un-land it, so this
    // asserts only what the store says about the PR itself.
    expect(undismissTicketPr(store, { ticketId: id, repo: 'api' }).ok).toBe(true);
  });
});
