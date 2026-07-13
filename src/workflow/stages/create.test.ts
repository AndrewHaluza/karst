import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { getTicket, listTickets, archiveTicket } from '../../store/tickets.js';
import { createTicketFlow } from './create.js';
import { STAGE_KEYS } from '../../model/types.js';

describe('createTicketFlow', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('seeds a ticket with all stages pending and stage_current=scope', () => {
    const t = createTicketFlow(store, { key: 'PROJ-142', title: 'add search' });
    const loaded = getTicket(store, t.id);
    expect(loaded.key).toBe('PROJ-142');
    expect(loaded.stageCurrent).toBe('scope');
    expect(loaded.stages).toHaveLength(STAGE_KEYS.length);
    expect(loaded.stages.every((s) => s.status === 'pending')).toBe(true);
  });

  it('records source=manual for hand-entered tickets', () => {
    const t = createTicketFlow(store, { key: 'X-1', title: 't' });
    expect(getTicket(store, t.id).source).toBe('manual');
  });

  it('persists description when supplied', () => {
    const t = createTicketFlow(store, {
      key: 'X-2',
      title: 't',
      description: 'acceptance criteria here',
    });
    expect(getTicket(store, t.id).description).toBe('acceptance criteria here');
  });

  it('reuses the existing ticket when the key already exists (idempotent)', () => {
    const first = createTicketFlow(store, { key: 'DUP-1', title: 'first' });
    const again = createTicketFlow(store, { key: 'DUP-1', title: 'second' });
    expect(again.id).toBe(first.id); // same row, not a duplicate
    expect(listTickets(store)).toHaveLength(1);
    // Existing fields are NOT clobbered by the second call.
    expect(getTicket(store, first.id).title).toBe('first');
  });

  it('creates distinct rows for distinct keys', () => {
    createTicketFlow(store, { key: 'A-1', title: 'a' });
    createTicketFlow(store, { key: 'B-1', title: 'b' });
    expect(listTickets(store)).toHaveLength(2);
  });

  it('resurrects an archived ticket when its key is created again', () => {
    const first = createTicketFlow(store, { key: 'ARC-1', title: 'first' });
    archiveTicket(store, first.id);
    expect(listTickets(store)).toHaveLength(0); // hidden while archived

    const again = createTicketFlow(store, { key: 'ARC-1', title: 'recreated' });
    expect(again.id).toBe(first.id); // same row, no duplicate
    expect(again.archivedAt).toBeNull(); // returned row is active
    expect(getTicket(store, first.id).archivedAt).toBeNull();
    // Back in the default (active) list, exactly one row.
    expect(listTickets(store).map((t) => t.id)).toEqual([first.id]);
    expect(listTickets(store, { includeArchived: true })).toHaveLength(1);
  });

  it('does not touch an active ticket found by key (still idempotent)', () => {
    const first = createTicketFlow(store, { key: 'ACT-1', title: 'first' });
    const again = createTicketFlow(store, { key: 'ACT-1', title: 'second' });
    expect(again.id).toBe(first.id);
    expect(again.archivedAt).toBeNull();
    expect(getTicket(store, first.id).title).toBe('first'); // unchanged
  });
});
