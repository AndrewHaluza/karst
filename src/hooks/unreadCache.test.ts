import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { markRead, postMessage } from '../store/ticketMessages.js';
import { createUnreadCache } from './unreadCache.js';

let store: Store;
let projectId: number;
let a: number;
let b: number;

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  a = createTicket(store, { key: 'A', title: 'a', projectId }).id;
  b = createTicket(store, { key: 'B', title: 'b', projectId }).id;
});

function send(to: number, body = 'hi'): number {
  return postMessage(store, { projectId, fromTicketId: null, toTicketId: to, kind: 'message', body }).id;
}

describe('createUnreadCache', () => {
  it('reads zero for an unknown ticket', () => {
    const cache = createUnreadCache();
    expect(cache.get(999)).toBe(0);
    expect(cache.watermark(999)).toBe(0);
  });

  it('refresh reads the project unread counts', () => {
    send(a);
    send(a);
    send(b);
    const cache = createUnreadCache();
    cache.refresh(store, projectId);
    expect(cache.get(a)).toBe(2);
    expect(cache.get(b)).toBe(1);
  });

  it('refresh drops tickets that were read since the last sweep', () => {
    const first = send(a);
    const cache = createUnreadCache();
    cache.refresh(store, projectId);
    expect(cache.get(a)).toBe(1);
    markRead(store, [first]);
    cache.refresh(store, projectId);
    expect(cache.get(a)).toBe(0);
  });

  it('exposes the unread watermark (highest id) as the batch identity', () => {
    const first = send(a);
    send(a);
    const cache = createUnreadCache();
    cache.refresh(store, projectId);
    expect(cache.get(a)).toBe(2);
    expect(cache.watermark(a)).toBeGreaterThan(first);
  });

  it('a read then a same-sized new batch keeps the count but raises the watermark', () => {
    const first = send(a);
    send(a);
    const cache = createUnreadCache();
    cache.refresh(store, projectId);
    const before = cache.watermark(a);
    markRead(store, [first]);
    const third = send(a);
    cache.refresh(store, projectId);
    expect(cache.get(a)).toBe(2);
    expect(cache.watermark(a)).toBeGreaterThan(before);
    expect(cache.watermark(a)).toBe(third);
  });

  it('replace rebuilds from explicit rows and ignores zero counts', () => {
    const cache = createUnreadCache();
    cache.replace([
      { toTicketId: b, unread: 3, maxId: 7 },
      { toTicketId: a, unread: 0, maxId: 2 },
    ]);
    expect(cache.get(b)).toBe(3);
    expect(cache.watermark(b)).toBe(7);
    expect(cache.get(a)).toBe(0);
    expect(cache.watermark(a)).toBe(0);
  });

  it('clear empties the cache', () => {
    const cache = createUnreadCache();
    cache.replace([{ toTicketId: a, unread: 1, maxId: 1 }]);
    cache.clear();
    expect(cache.get(a)).toBe(0);
    expect(cache.watermark(a)).toBe(0);
  });
});
