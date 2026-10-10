import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { hasUatGatePass, recordUatGatePass } from './uatGatePasses.js';

describe('uatGatePasses', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'K-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  it('matches only the same ticket, attempt and fingerprint', () => {
    recordUatGatePass(store, { ticketId: id, attempt: 0, fingerprint: 'fp', runAt: 't' });
    expect(hasUatGatePass(store, id, 0, 'fp')).toBe(true);
    expect(hasUatGatePass(store, id, 1, 'fp')).toBe(false);
    expect(hasUatGatePass(store, id, 0, 'other')).toBe(false);
    expect(hasUatGatePass(store, id + 1, 0, 'fp')).toBe(false);
  });
});
