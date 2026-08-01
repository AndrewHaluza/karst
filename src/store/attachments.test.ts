import { describe, it, expect, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, deleteTicket } from './tickets.js';
import {
  listAttachments,
  insertAttachment,
  findAttachmentByStoredName,
  getAttachment,
  deleteAttachment,
} from './attachments.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function freshStore(): Store {
  const store = openStore(':memory:');
  cleanups.push(() => store.close());
  return store;
}

function seedTicket(store: Store, key = 'T-1'): number {
  return createTicket(store, { key, title: `title ${key}` }).id;
}

describe('ticket attachments store', () => {
  it('returns an empty list for a ticket with no attachments', () => {
    const store = freshStore();
    expect(listAttachments(store, seedTicket(store))).toEqual([]);
  });

  it('round-trips every field of an inserted attachment', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'a3f9e1b2c3d4e5f6.png',
      originalName: 'login-error.png',
      byteSize: 4096,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listAttachments(store, ticketId)).toEqual([
      {
        id: row.id,
        ticketId,
        kind: 'image',
        storedName: 'a3f9e1b2c3d4e5f6.png',
        originalName: 'login-error.png',
        byteSize: 4096,
        createdAt: row.createdAt,
      },
    ]);
  });

  it('scopes the list to one ticket', () => {
    const store = freshStore();
    const a = seedTicket(store, 'T-A');
    const b = seedTicket(store, 'T-B');
    insertAttachment(store, {
      ticketId: a, kind: 'image', storedName: 'aaa.png', originalName: 'a.png', byteSize: 1,
    });
    insertAttachment(store, {
      ticketId: b, kind: 'video', storedName: 'bbb.mp4', originalName: 'b.mov', byteSize: 2,
    });
    expect(listAttachments(store, a).map((r) => r.storedName)).toEqual(['aaa.png']);
    expect(listAttachments(store, b).map((r) => r.storedName)).toEqual(['bbb.mp4']);
  });

  it('orders oldest first, then by id', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    for (const n of ['one', 'two', 'three']) {
      insertAttachment(store, {
        ticketId, kind: 'image', storedName: `${n}.png`, originalName: `${n}.png`, byteSize: 1,
      });
    }
    expect(listAttachments(store, ticketId).map((r) => r.storedName)).toEqual([
      'one.png', 'two.png', 'three.png',
    ]);
  });

  it('finds an existing row by its content-addressed stored name', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'dead.png', originalName: 'x.png', byteSize: 9,
    });
    expect(findAttachmentByStoredName(store, ticketId, 'dead.png')).toEqual(row);
    expect(findAttachmentByStoredName(store, ticketId, 'beef.png')).toBeNull();
  });

  // Scoped by ticket, not global: the same bytes attached to two tickets are two
  // files in two directories, so a dedupe hit must not cross a ticket boundary.
  it('does not find another ticket\'s row by stored name', () => {
    const store = freshStore();
    const a = seedTicket(store, 'T-A');
    const b = seedTicket(store, 'T-B');
    insertAttachment(store, {
      ticketId: a, kind: 'image', storedName: 'same.png', originalName: 'x.png', byteSize: 1,
    });
    expect(findAttachmentByStoredName(store, b, 'same.png')).toBeNull();
  });

  it('gets and deletes a single attachment by id', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId, kind: 'video', storedName: 'clip.mp4', originalName: 'repro.mov', byteSize: 77,
    });
    expect(getAttachment(store, row.id)).toEqual(row);
    deleteAttachment(store, row.id);
    expect(getAttachment(store, row.id)).toBeNull();
    expect(listAttachments(store, ticketId)).toEqual([]);
  });

  it('deletes a ticket\'s attachment rows with the ticket', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'gone.png', originalName: 'gone.png', byteSize: 3,
    });
    deleteTicket(store, ticketId);
    expect(listAttachments(store, ticketId)).toEqual([]);
  });
});
