import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { resolveTicketByKey } from './resolveTicket.js';

describe('resolveTicketByKey', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('prefers the ticket scoped to the manifest project', () => {
    const alpha = upsertProject(store, { slug: 'alpha' });
    const beta = upsertProject(store, { slug: 'beta' });
    createTicket(store, { key: 'SHARED-1', title: 'alpha', projectId: alpha.id });
    createTicket(store, { key: 'SHARED-1', title: 'beta', projectId: beta.id });

    expect(resolveTicketByKey(store, 'SHARED-1', 'beta')?.projectId).toBe(beta.id);
  });

  it('resolves a numeric row id within the scoped project', () => {
    const beta = upsertProject(store, { slug: 'beta' });
    const ticket = createTicket(store, { key: 'B-1', title: 'beta', projectId: beta.id });

    expect(resolveTicketByKey(store, String(ticket.id), 'beta')?.id).toBe(ticket.id);
  });

  it('never resolves a numeric id belonging to another project', () => {
    const alpha = upsertProject(store, { slug: 'alpha' });
    const beta = upsertProject(store, { slug: 'beta' });
    const alphaTicket = createTicket(store, { key: 'A-1', title: 'alpha', projectId: alpha.id });
    createTicket(store, { key: 'B-1', title: 'beta', projectId: beta.id });

    expect(resolveTicketByKey(store, String(alphaTicket.id), 'beta')).toBeUndefined();
  });

  it('still resolves a numeric id unscoped when no project is known', () => {
    const ticket = createTicket(store, { key: 'A-1', title: 'unadopted' });

    expect(resolveTicketByKey(store, String(ticket.id), undefined)?.id).toBe(ticket.id);
  });

  it('rejects non-canonical numeric spellings', () => {
    const ticket = createTicket(store, { key: 'A-1', title: 'unadopted' });

    expect(resolveTicketByKey(store, `0${ticket.id}`, undefined)).toBeUndefined();
  });

  it('prefers a key that looks numeric over the row id', () => {
    const beta = upsertProject(store, { slug: 'beta' });
    const first = createTicket(store, { key: 'B-1', title: 'first', projectId: beta.id });
    const numericKey = createTicket(store, {
      key: String(first.id),
      title: 'numeric key',
      projectId: beta.id,
    });

    expect(resolveTicketByKey(store, String(first.id), 'beta')?.id).toBe(numericKey.id);
  });
});
