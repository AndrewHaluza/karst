import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { archiveTicket, createTicket } from '../store/tickets.js';
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

  // NDL-95: a reused/re-created key used to resolve to whichever row came first
  // (the lowest id), so `context --ticket TEST-TASK` returned the archived ticket
  // and hid the live one. Active wins.
  it('prefers a non-archived namesake over the archived one, unscoped', () => {
    const stale = createTicket(store, { key: 'TEST-TASK', title: 'stale' });
    archiveTicket(store, stale.id);
    const live = createTicket(store, { key: 'TEST-TASK', title: 'live' });

    expect(resolveTicketByKey(store, 'TEST-TASK', undefined)?.id).toBe(live.id);
  });

  it('prefers a non-archived namesake over the archived one, within the scoped project', () => {
    const beta = upsertProject(store, { slug: 'beta' });
    const stale = createTicket(store, { key: 'DUP-1', title: 'stale', projectId: beta.id });
    archiveTicket(store, stale.id);
    const live = createTicket(store, { key: 'DUP-1', title: 'live', projectId: beta.id });

    expect(resolveTicketByKey(store, 'DUP-1', 'beta')?.id).toBe(live.id);
  });

  it('still resolves the sole archived namesake when no active one holds the key', () => {
    const stale = createTicket(store, { key: 'GONE-1', title: 'archived only' });
    archiveTicket(store, stale.id);

    expect(resolveTicketByKey(store, 'GONE-1', undefined)?.id).toBe(stale.id);
  });

  // Two live tickets with one key cannot be disambiguated by activity, so the
  // resolver refuses rather than silently picking the older row.
  it('throws an explicit ambiguity error when two non-archived tickets share a key, unscoped', () => {
    const first = createTicket(store, { key: 'AMB-1', title: 'first' });
    const second = createTicket(store, { key: 'AMB-1', title: 'second' });

    expect(() => resolveTicketByKey(store, 'AMB-1', undefined)).toThrow(/ambiguous/i);
    expect(() => resolveTicketByKey(store, 'AMB-1', undefined)).toThrow(
      new RegExp(`T${first.id}.*T${second.id}`),
    );
  });

  it('throws an explicit ambiguity error within the scoped project', () => {
    const beta = upsertProject(store, { slug: 'beta' });
    createTicket(store, { key: 'AMB-2', title: 'first', projectId: beta.id });
    createTicket(store, { key: 'AMB-2', title: 'second', projectId: beta.id });

    expect(() => resolveTicketByKey(store, 'AMB-2', 'beta')).toThrow(/ambiguous/i);
  });

  it('resolves T<n>, t<n> and bare n to ticket n', () => {
    const t = createTicket(store, { key: 'A-1', title: 'x' });
    expect(resolveTicketByKey(store, `T${t.id}`, undefined)?.id).toBe(t.id);
    expect(resolveTicketByKey(store, `t${t.id}`, undefined)?.id).toBe(t.id);
    expect(resolveTicketByKey(store, `${t.id}`, undefined)?.id).toBe(t.id);
  });

  it('scopes T<n> to the manifest project', () => {
    const alpha = upsertProject(store, { slug: 'alpha' });
    const beta = upsertProject(store, { slug: 'beta' });
    const a = createTicket(store, { key: 'A-1', title: 'a', projectId: alpha.id });
    expect(resolveTicketByKey(store, `T${a.id}`, 'beta')).toBeUndefined();
  });

  it('returns undefined for other kinds and zero ids', () => {
    createTicket(store, { key: 'A-1', title: 'x' });
    expect(resolveTicketByKey(store, 'D5', undefined)).toBeUndefined();
    expect(resolveTicketByKey(store, 'T0', undefined)).toBeUndefined();
  });

  it('lists ambiguous candidates as T<id>', () => {
    const a = createTicket(store, { key: 'DUP-1', title: 'a' });
    const b = createTicket(store, { key: 'DUP-1', title: 'b' });
    expect(() => resolveTicketByKey(store, 'DUP-1', undefined)).toThrow(
      new RegExp(`T${a.id}, T${b.id}`),
    );
  });
});
