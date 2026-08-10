import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import {
  createTicket,
  getTicket,
  getTicketByKey,
  listTickets,
  archiveTicket,
} from '../store/tickets.js';
import { createTicketFromApi, parseCreateTicketRequest } from './ticketApi.js';

describe('parseCreateTicketRequest', () => {
  it('accepts a title and trims it', () => {
    const r = parseCreateTicketRequest({ title: '  Fix login  ' });
    expect(r).toEqual({ ok: true, request: { title: 'Fix login' } });
  });

  it('accepts an optional description and key, trimming both', () => {
    const r = parseCreateTicketRequest({
      title: 'Fix login',
      description: '  detail  ',
      key: '  LOGIN-1  ',
    });
    expect(r).toEqual({
      ok: true,
      request: { title: 'Fix login', description: 'detail', key: 'LOGIN-1' },
    });
  });

  it('drops a blank description and a blank key (caller derives the key)', () => {
    const r = parseCreateTicketRequest({
      title: 'Fix login',
      description: '   ',
      key: '',
    });
    expect(r).toEqual({ ok: true, request: { title: 'Fix login' } });
  });

  it('rejects a missing title', () => {
    expect(parseCreateTicketRequest({})).toEqual({
      ok: false,
      message: 'title is required',
    });
  });

  it('rejects a blank title', () => {
    expect(parseCreateTicketRequest({ title: '   ' })).toEqual({
      ok: false,
      message: 'title is required',
    });
  });

  it('rejects a non-string title, description or key', () => {
    expect(parseCreateTicketRequest({ title: 42 })).toEqual({
      ok: false,
      message: 'title must be a string',
    });
    expect(parseCreateTicketRequest({ title: 'x', description: 42 })).toEqual({
      ok: false,
      message: 'description must be a string',
    });
    expect(parseCreateTicketRequest({ title: 'x', key: [] })).toEqual({
      ok: false,
      message: 'key must be a string',
    });
  });

  it('rejects a body that is not a JSON object', () => {
    expect(parseCreateTicketRequest(null)).toEqual({
      ok: false,
      message: 'request body must be a JSON object',
    });
    expect(parseCreateTicketRequest([{ title: 'x' }])).toEqual({
      ok: false,
      message: 'request body must be a JSON object',
    });
  });

  it('ignores unknown fields (caller may send extras)', () => {
    const r = parseCreateTicketRequest({ title: 'Fix login', priority: 1 });
    expect(r.ok).toBe(true);
  });
});

describe('createTicketFromApi', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('creates a persisted ticket with a title-derived key', () => {
    const t = createTicketFromApi(store, { title: 'Fix login redirect' });
    expect(t.key).toBe('FIX-LOGIN-REDIRECT');
    expect(t.title).toBe('Fix login redirect');
    expect(getTicketByKey(store, 'FIX-LOGIN-REDIRECT')).not.toBeNull();
    expect(listTickets(store).some((x) => x.id === t.id)).toBe(true);
  });

  it('persists the description', () => {
    const t = createTicketFromApi(store, {
      title: 'Fix login redirect',
      description: 'session cookie not set',
    });
    expect(getTicket(store, t.id).description).toBe('session cookie not set');
  });

  it('honors an explicit key without touching the title derivation', () => {
    const t = createTicketFromApi(store, { key: 'LOGIN-1', title: 'Fix login' });
    expect(t.key).toBe('LOGIN-1');
    expect(getTicketByKey(store, 'LOGIN-1')?.id).toBe(t.id);
  });

  it('derives a suffixed key on a collision', () => {
    createTicket(store, { key: 'FIX-LOGIN', title: 'existing' });
    const t = createTicketFromApi(store, { title: 'Fix login' });
    expect(t.key).toBe('FIX-LOGIN-2');
  });

  it('is idempotent by key: recreating the same key returns the same row', () => {
    const first = createTicketFromApi(store, { key: 'LOGIN-1', title: 'a' });
    const second = createTicketFromApi(store, { key: 'LOGIN-1', title: 'b' });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('a'); // existing fields untouched
  });

  it('resurrects an archived ticket on key collision', () => {
    const t = createTicketFromApi(store, { key: 'LOGIN-1', title: 'a' });
    archiveTicket(store, t.id);
    const again = createTicketFromApi(store, { key: 'LOGIN-1', title: 'a' });
    expect(again.archivedAt).toBeNull();
  });

  it('scopes the key uniqueness pass to the given project', () => {
    createTicket(store, { key: 'FIX-LOGIN', title: 'in A', projectId: 1 });
    const inB = createTicketFromApi(store, { title: 'Fix login' }, { projectId: 2 });
    expect(inB.key).toBe('FIX-LOGIN'); // project A's key does not collide here
    expect(inB.projectId).toBe(2);
  });
});
