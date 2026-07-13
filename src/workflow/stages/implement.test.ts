import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { markImplementDone } from './implement.js';
import { transition } from '../machine.js';

describe('markImplementDone', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    // walk to impl (scope pass) — impl is an explicit-marker boundary.
    transition(store, ticketId, 'scope', { kind: 'passed' });
  });

  it('transitions impl -> uat via an explicit marker (never a Stop hook)', () => {
    const next = markImplementDone(store, ticketId);
    expect(next).toBe('uat');
    expect(getTicket(store, ticketId).stageCurrent).toBe('uat');
  });
});
