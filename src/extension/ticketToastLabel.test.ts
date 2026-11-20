import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { ticketToastLabel } from './ticketToastLabel.js';

describe('ticketToastLabel', () => {
  it('names a stored ticket with its ref, key and title', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'A-1', title: 'Fix login' });
    expect(ticketToastLabel(store, t.id)).toBe(`T${t.id} · A-1 "Fix login"`);
  });

  it('falls back to the bare ref when the ticket row is gone', () => {
    const store = openStore(':memory:');
    expect(ticketToastLabel(store, 999)).toBe('T999');
  });
});
