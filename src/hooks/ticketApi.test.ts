import { describe, it, expect } from 'vitest';
import { parseCreateTicketRequest } from './ticketApi.js';

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
