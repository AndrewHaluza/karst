import { describe, it, expect } from 'vitest';
import { openStore } from './db.js';
import { createTicket } from './tickets.js';
import { recordFindings } from './reviewFindings.js';
import { recordStallNote, stallNote } from './stallNote.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

describe('stallNote', () => {
  it('returns the newest note', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'N-1', title: 't' });
    recordStallNote(store, t.id, 1, T0, 'first');
    recordStallNote(store, t.id, 1, T1, 'second');
    expect(stallNote(store, t.id)).toBe('second');
  });
  it('is null without a note', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'N-2', title: 't' });
    expect(stallNote(store, t.id)).toBeNull();
  });
  it('lapses once a newer agent review batch exists', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'N-3', title: 't' });
    recordStallNote(store, t.id, 1, T0, 'first');
    recordFindings(store, {
      ticketId: t.id, attempt: 2, runAt: T1,
      findings: [{ severity: 'high', repo: '', title: 'x', detail: 'd', source: 'agent' }],
    });
    expect(stallNote(store, t.id)).toBeNull();
  });
});
