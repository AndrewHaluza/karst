import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket } from './tickets.js';
import { markRead, postMessage } from './ticketMessages.js';
import {
  claimWake,
  maxMessageId,
  pendingWakeEvents,
  unreadByRecipient,
} from './messageDelivery.js';

describe('message delivery store reads', () => {
  let store: Store;
  let projectId: number;
  let otherProject: number;
  let parentId: number;
  let childId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    otherProject = upsertProject(store, { slug: 'q' }).id;
    parentId = createTicket(store, { key: 'P-1', title: 'parent', projectId }).id;
    childId = createTicket(store, { key: 'P-1-s1', title: 'c', projectId, subtaskParentId: parentId }).id;
  });
  afterEach(() => store.close());

  function post(kind: 'message' | 'event', to = parentId, project: number = projectId) {
    return postMessage(store, {
      projectId: project,
      fromTicketId: kind === 'event' ? null : childId,
      toTicketId: to,
      kind,
      body: kind === 'event' ? 'P-1-s1 landed (done)' : 'hi',
    });
  }

  it('maxMessageId is 0 on an empty mailbox, else the highest id', () => {
    expect(maxMessageId(store)).toBe(0);
    const m = post('message');
    expect(maxMessageId(store)).toBe(m.id);
  });

  it('groups unread rows by recipient within the project only', () => {
    const a = post('message');
    const b = post('event');
    const read = post('message', childId);
    markRead(store, [read.id]);
    post('message', parentId, otherProject);
    expect(unreadByRecipient(store, projectId)).toEqual([{ toTicketId: parentId, unread: 2, maxId: b.id }]);
    expect(a.id).toBeLessThan(b.id);
  });

  it('bounds both reads and returns plain numbers', () => {
    for (let i = 0; i < 5; i++) post('event');
    const evs = pendingWakeEvents(store, projectId, 0, 2);
    expect(evs).toHaveLength(2);
    expect(evs[0]!.id).toBeLessThan(evs[1]!.id);
    const other = createTicket(store, { key: 'P-2', title: 'x', projectId }).id;
    post('message', other);
    expect(unreadByRecipient(store, projectId, 1)).toHaveLength(1);
    const [r] = unreadByRecipient(store, projectId);
    expect(typeof r!.unread).toBe('number');
    expect(typeof r!.maxId).toBe('number');
    expect(typeof maxMessageId(store)).toBe('number');
  });

  it('lists unclaimed events after an id, and claims each exactly once', () => {
    const old = post('event');
    post('message');
    const fresh = post('event');
    post('event', parentId, otherProject);
    expect(pendingWakeEvents(store, projectId, old.id).map((e) => e.id)).toEqual([fresh.id]);
    expect(claimWake(store, fresh.id)).toBe(true);
    expect(claimWake(store, fresh.id)).toBe(false);
    expect(pendingWakeEvents(store, projectId, 0).map((e) => e.id)).toEqual([old.id]);
  });
});
