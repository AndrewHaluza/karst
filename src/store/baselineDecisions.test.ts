import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { latestBaselineDecisions, recordBaselineDecisions } from './baselineDecisions.js';

describe('baselineDecisions', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'K-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  it('is empty before any decision', () => {
    expect(latestBaselineDecisions(store, ticketId).size).toBe(0);
  });

  it('keeps the LATEST row per (repo, path), append-only underneath', () => {
    recordBaselineDecisions(store, ticketId, [
      { repo: 'r', path: 'a.png', sha256: 's1', decision: 'rejected', reason: 'blurry' },
    ], '2026-01-01T00:00:00Z');
    recordBaselineDecisions(store, ticketId, [
      { repo: 'r', path: 'a.png', sha256: 's2', decision: 'approved', reason: null },
      { repo: 'r', path: 'b.png', sha256: 's3', decision: 'approved', reason: null },
    ], '2026-01-02T00:00:00Z');
    const latest = latestBaselineDecisions(store, ticketId);
    expect(latest.get('r\0a.png')).toEqual({
      sha256: 's2', decision: 'approved', reason: null, decidedAt: '2026-01-02T00:00:00Z',
    });
    expect(latest.get('r\0b.png')?.sha256).toBe('s3');
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM baseline_decisions').get() as { n: number };
    expect(rows.n).toBe(3);
  });

  it('scopes decisions to the ticket', () => {
    const other = createTicket(store, { key: 'K-2', title: 'u' }).id;
    recordBaselineDecisions(store, other, [
      { repo: 'r', path: 'a.png', sha256: 's', decision: 'approved', reason: null },
    ], '2026-01-01T00:00:00Z');
    expect(latestBaselineDecisions(store, ticketId).size).toBe(0);
  });

  it('writes a batch atomically', () => {
    expect(() =>
      recordBaselineDecisions(store, ticketId, [
        { repo: 'r', path: 'a.png', sha256: 's', decision: 'approved', reason: null },
        { repo: 'r', path: 'b.png', sha256: 's', decision: 'bogus' as 'approved', reason: null },
      ], '2026-01-01T00:00:00Z'),
    ).toThrow();
    expect(latestBaselineDecisions(store, ticketId).size).toBe(0);
  });
});
