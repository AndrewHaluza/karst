import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './db.js';
import { createTicket, deleteTicket } from './tickets.js';
import {
  listAttachments,
  insertAttachment,
  findAttachmentByStoredName,
  getAttachment,
  deleteAttachment,
  abortAttachmentWrite,
  attachmentWriteState,
  beginAttachmentWrite,
  finalizeAttachmentDetach,
  finalizeAttachmentWrite,
  prepareAttachmentDetach,
  releaseAttachmentOperation,
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
    expect(row).not.toBeNull();
    if (!row) return;
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

  it('atomically returns the same row when two store connections attach the same bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-attachment-store-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const first = openStore(path);
    const second = openStore(path);
    cleanups.push(() => second.close());
    cleanups.push(() => first.close());
    const ticketId = seedTicket(first);
    const input = {
      ticketId,
      kind: 'image' as const,
      storedName: 'same.png',
      originalName: 'first.png',
      byteSize: 4,
    };

    const inserted = insertAttachment(first, input);
    const deduped = insertAttachment(second, { ...input, originalName: 'second.png' });

    expect(deduped).toEqual(inserted);
    expect(listAttachments(first, ticketId)).toEqual([inserted]);
  });

  it('refuses an attachment insert after its parent ticket is gone', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    deleteTicket(store, ticketId);

    expect(insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'orphan.png',
      originalName: 'orphan.png',
      byteSize: 6,
    })).toBeNull();
    expect(listAttachments(store, ticketId)).toEqual([]);
  });

  it('reports a write claim missing when hard delete wins before publication finalizes', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const claim = beginAttachmentWrite(store, {
      ticketId,
      kind: 'image',
      storedName: 'late.png',
      originalName: 'late.png',
      byteSize: 4,
    });
    expect(claim).not.toBeNull();
    if (!claim || claim.kind === 'busy') return;

    deleteTicket(store, ticketId);

    expect(attachmentWriteState(store, claim.row.id, claim.token)).toBe('missing');
    expect(finalizeAttachmentWrite(store, claim.row.id, claim.token)).toBe('missing');
  });

  it('preserves the canonical row when a reused publication claim aborts', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const canonical = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'same.png',
      originalName: 'first.png',
      byteSize: 4,
    });
    expect(canonical).not.toBeNull();
    if (!canonical) return;
    const claim = beginAttachmentWrite(store, {
      ticketId,
      kind: 'image',
      storedName: 'same.png',
      originalName: 'again.png',
      byteSize: 4,
    });
    expect(claim?.kind).toBe('claimed');
    if (!claim || claim.kind === 'busy') return;
    expect(claim.inserted).toBe(false);

    abortAttachmentWrite(store, claim);

    expect(getAttachment(store, canonical.id)).toEqual(canonical);
  });

  it('serializes active attach claims instead of superseding an unfinished writer', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const input = {
      ticketId,
      kind: 'image' as const,
      storedName: 'serialized.png',
      originalName: 'first.png',
      byteSize: 4,
    };
    const first = beginAttachmentWrite(store, input);
    expect(first?.kind).toBe('claimed');
    if (!first || first.kind === 'busy') return;

    expect(beginAttachmentWrite(store, input)).toEqual({ kind: 'busy' });

    releaseAttachmentOperation(store, first.row.id, first.token);
    const second = beginAttachmentWrite(store, input);
    expect(second?.kind).toBe('claimed');
    if (!second || second.kind === 'busy') return;
    expect(second.inserted).toBe(false);
    releaseAttachmentOperation(store, second.row.id, second.token);
  });

  it('takes over an expired attach lease and clears an expired detach lease', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'stale.png',
      originalName: 'stale.png',
      byteSize: 4,
    });
    expect(row).not.toBeNull();
    if (!row) return;
    store.db.prepare(
      'UPDATE ticket_attachments SET operation_token = ?, detach_token = ? WHERE id = ?',
    ).run('attach:0:expired', 'detach:0:expired', row.id);

    const recovered = beginAttachmentWrite(store, {
      ticketId,
      kind: 'image',
      storedName: 'stale.png',
      originalName: 'retry.png',
      byteSize: 4,
    });

    expect(recovered?.kind).toBe('claimed');
    if (!recovered || recovered.kind === 'busy') return;
    expect(attachmentWriteState(store, row.id, recovered.token)).toBe('ready');
    const tokens = store.db.prepare(
      'SELECT detach_token FROM ticket_attachments WHERE id = ?',
    ).get(row.id) as { detach_token: string | null };
    expect(tokens.detach_token).toBeNull();
    releaseAttachmentOperation(store, row.id, recovered.token);
  });

  it('lets detach recover an expired attach lease instead of staying disabled', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'stale-detach.png',
      originalName: 'stale-detach.png',
      byteSize: 4,
    });
    expect(row).not.toBeNull();
    if (!row) return;
    store.db.prepare(
      'UPDATE ticket_attachments SET operation_token = ? WHERE id = ?',
    ).run('attach:0:expired', row.id);

    const recovered = prepareAttachmentDetach(store, row.id, ticketId);

    expect(recovered?.needsUnlink).toBe(true);
  });

  it('resumes a retained detach claim after filesystem removal already succeeded', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'resume.png',
      originalName: 'resume.png',
      byteSize: 4,
    });
    expect(row).not.toBeNull();
    if (!row) return;
    const first = prepareAttachmentDetach(store, row.id, ticketId);
    expect(first?.needsUnlink).toBe(true);
    if (!first || !first.needsUnlink) return;

    const resumed = prepareAttachmentDetach(store, row.id, ticketId);

    expect(resumed).toEqual(first);
    if (!resumed || !resumed.needsUnlink) return;
    expect(finalizeAttachmentDetach(store, row.id, resumed.token)).toBe('detached');
  });

  it('lets a concurrent attach cancel a claimed detach before final row deletion', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'raced.png',
      originalName: 'first.png',
      byteSize: 4,
    });
    expect(row).not.toBeNull();
    if (!row) return;

    const decision = prepareAttachmentDetach(store, row.id, ticketId);
    expect(decision?.needsUnlink).toBe(true);
    const claim = store.db.prepare(
      'SELECT detach_token FROM ticket_attachments WHERE id = ?',
    ).get(row.id) as { detach_token: string | null };
    expect(claim.detach_token).toMatch(/^detach:/);

    const attached = beginAttachmentWrite(store, {
      ticketId,
      kind: 'image',
      storedName: 'raced.png',
      originalName: 'second.png',
      byteSize: 4,
    });
    expect(attached).not.toBeNull();
    if (!attached || attached.kind === 'busy') return;
    expect(attachmentWriteState(store, row.id, attached.token)).toBe('waiting-for-detach');

    const staleFinalize = finalizeAttachmentDetach(store, row.id, claim.detach_token!);

    expect(staleFinalize).toBe('canceled');
    expect(attachmentWriteState(store, row.id, attached.token)).toBe('ready');
    expect(getAttachment(store, row.id)).toEqual(attached.row);
    releaseAttachmentOperation(store, row.id, attached.token);
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
    expect(row).not.toBeNull();
    if (!row) return;
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
