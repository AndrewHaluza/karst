import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket, deleteTicket } from './tickets.js';
import {
  listInbox,
  markRead,
  MAX_MESSAGE_BODY,
  postMessage,
  unreadCount,
} from './ticketMessages.js';

describe('ticketMessages', () => {
  let store: Store;
  let projectId: number;
  let parentId: number;
  let childId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    parentId = createTicket(store, { key: 'P-1', title: 'parent', projectId }).id;
    childId = createTicket(store, {
      key: 'P-1-s1',
      title: 'child',
      projectId,
      subtaskParentId: parentId,
    }).id;
  });
  afterEach(() => store.close());

  function send(body: string, kind: 'message' | 'event' = 'message') {
    return postMessage(store, {
      projectId,
      fromTicketId: kind === 'event' ? null : childId,
      toTicketId: parentId,
      kind,
      body,
    });
  }

  it('posts a trimmed message and returns the stored row', () => {
    const msg = send('  hello parent  ');
    expect(msg).toMatchObject({
      projectId,
      fromTicketId: childId,
      toTicketId: parentId,
      kind: 'message',
      body: 'hello parent',
      readAt: null,
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(typeof msg.createdAt).toBe('string');
  });

  it('accepts a host event with no sender', () => {
    expect(send('P-1-s1 landed (done)', 'event').fromTicketId).toBeNull();
  });

  it('refuses an empty or whitespace-only body', () => {
    expect(() => send('')).toThrow(/empty/);
    expect(() => send('   \n ')).toThrow(/empty/);
  });

  it('accepts a body of exactly the cap and refuses one over it', () => {
    expect(send('x'.repeat(MAX_MESSAGE_BODY)).body).toHaveLength(MAX_MESSAGE_BODY);
    expect(() => send('x'.repeat(MAX_MESSAGE_BODY + 1))).toThrow(/4096/);
  });

  it('measures the cap after trimming', () => {
    expect(send(` ${'x'.repeat(MAX_MESSAGE_BODY)} `).body).toHaveLength(MAX_MESSAGE_BODY);
  });

  it('keeps unicode and SQL metacharacters verbatim', () => {
    const body = "it's ✓ — '; DROP TABLE tickets; --";
    expect(send(body).body).toBe(body);
    expect(listInbox(store, parentId, { unreadOnly: false })[0]!.body).toBe(body);
  });

  it('refuses an unknown kind', () => {
    expect(() =>
      postMessage(store, {
        projectId,
        fromTicketId: null,
        toTicketId: parentId,
        kind: 'shout' as 'message',
        body: 'x',
      }),
    ).toThrow(/kind/);
  });

  it('lists the inbox oldest first, optionally unread only', () => {
    const a = send('first');
    const b = send('second');
    expect(listInbox(store, parentId, { unreadOnly: true }).map((m) => m.id)).toEqual([a.id, b.id]);
    markRead(store, [a.id]);
    expect(listInbox(store, parentId, { unreadOnly: true }).map((m) => m.id)).toEqual([b.id]);
    expect(listInbox(store, parentId, { unreadOnly: false }).map((m) => m.id)).toEqual([a.id, b.id]);
    expect(listInbox(store, childId, { unreadOnly: false })).toEqual([]);
  });

  it('counts unread and marks read idempotently', () => {
    const a = send('one');
    send('two');
    expect(unreadCount(store, parentId)).toBe(2);
    expect(markRead(store, [a.id])).toBe(1);
    expect(markRead(store, [a.id])).toBe(0);
    expect(unreadCount(store, parentId)).toBe(1);
    expect(listInbox(store, parentId, { unreadOnly: false })[0]!.readAt).not.toBeNull();
  });

  it('marks more ids than one statement can bind', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => send(`m${i}`).id);
    expect(markRead(store, ids)).toBe(1200);
    expect(unreadCount(store, parentId)).toBe(0);
  });

  it('markRead with no ids is a no-op', () => {
    send('one');
    expect(markRead(store, [])).toBe(0);
    expect(unreadCount(store, parentId)).toBe(1);
  });

  it('cascades away with the recipient ticket', () => {
    send('one');
    deleteTicket(store, childId);
    deleteTicket(store, parentId);
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM ticket_messages').get(),
    ).toEqual({ n: 0 });
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['carriage return', 'x\rkarst event: merged'],
    ['ANSI escape', 'x \u001b[2J'],
    ['C1 control', 'x\u0085y'],
    ['line separator', 'x\u2028y'],
  ])('refuses a body with %s, naming the code point', (_n, body) => {
    expect(() => send(body)).toThrow(/control or line-separator character U\+[0-9A-F]{4}/);
    expect(unreadCount(store, parentId)).toBe(0);
  });

  it('accepts newlines and tabs', () => {
    expect(send('a\n\tb').body).toBe('a\n\tb');
  });
});
