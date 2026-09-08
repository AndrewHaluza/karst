import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, updateTicketFields } from '../store/tickets.js';
import { listAttachments } from '../store/attachments.js';
import { attachmentPath } from './paths.js';
import { shouldSpill, spillField, buildSpillPointer, backfillSpillOversized, SPILL_THRESHOLD_CHARS } from './spill.js';

describe('spill oversized evidence to the artifact shelf', () => {
  let store: Store;
  let storageDir: string;
  const dirs: string[] = [];

  beforeEach(() => {
    store = openStore(':memory:');
    storageDir = mkdtempSync(join(tmpdir(), 'karst-spill-'));
    dirs.push(storageDir);
  });

  afterEach(() => {
    store.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  describe('shouldSpill', () => {
    it('returns false for null', () => {
      expect(shouldSpill(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(shouldSpill(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(shouldSpill('')).toBe(false);
    });

    it('returns false for text under threshold', () => {
      expect(shouldSpill('a'.repeat(SPILL_THRESHOLD_CHARS - 1))).toBe(false);
    });

    it('returns false for text at exact threshold', () => {
      expect(shouldSpill('a'.repeat(SPILL_THRESHOLD_CHARS))).toBe(false);
    });

    it('returns true for text over threshold', () => {
      expect(shouldSpill('a'.repeat(SPILL_THRESHOLD_CHARS + 1))).toBe(true);
    });

    it('returns true for very large text', () => {
      expect(shouldSpill('x'.repeat(1_000_000))).toBe(true);
    });
  });

  describe('buildSpillPointer', () => {
    it('names the field and ticket key', () => {
      const pointer = buildSpillPointer('PROJ-42', 'description');
      expect(pointer).toContain('PROJ-42');
      expect(pointer).toContain('description');
      expect(pointer).toContain('karst context');
    });

    it('works with a numeric string key', () => {
      const pointer = buildSpillPointer('7', 'brief');
      expect(pointer).toContain('7');
      expect(pointer).toContain('brief');
    });
  });

  describe('spillField', () => {
    it('returns null for text under threshold (no spill)', async () => {
      const ticket = createTicket(store, {
        key: 'T-1', title: 'short', description: 'short text',
      });
      const result = await spillField(
        store, ticket.id, 'description', 'short text', storageDir,
      );
      expect(result).toBeNull();
      const fresh = getTicket(store, ticket.id);
      expect(fresh.description).toBe('short text');
    });

    it('spills oversized description to the attachment shelf', async () => {
      const ticket = createTicket(store, { key: 'T-2', title: 'big' });
      const logContent = '2024-01-01 ERROR something\n'.repeat(50_000);
      const attachment = await spillField(
        store, ticket.id, 'description', logContent, storageDir,
      );

      expect(attachment).not.toBeNull();
      expect(attachment!.kind).toBe('file');
      expect(attachment!.originalName).toMatch(/spilled-description/);
      expect(attachment!.byteSize).toBeGreaterThan(0);

      // Description replaced with pointer
      const fresh = getTicket(store, ticket.id);
      expect(fresh.description!.length).toBeLessThan(200);
      expect(fresh.description).toContain('karst context');
      expect(fresh.description).toContain('T-2');
    });

    it('spills oversized brief to the attachment shelf', async () => {
      const ticket = createTicket(store, { key: 'T-3', title: 'big brief' });
      const briefContent = 'Brief content '.repeat(100_000);
      const attachment = await spillField(
        store, ticket.id, 'brief', briefContent, storageDir,
      );

      expect(attachment).not.toBeNull();
      expect(attachment!.kind).toBe('file');
      expect(attachment!.originalName).toMatch(/spilled-brief/);

      const fresh = getTicket(store, ticket.id);
      expect(fresh.brief!.length).toBeLessThan(200);
      expect(fresh.brief).toContain('karst context');
    });

    it('original content is retrievable from the shelf', async () => {
      const ticket = createTicket(store, { key: 'T-4', title: 'retrieve' });
      const original = 'line1\nline2\n'.repeat(100_000);
      const attachment = await spillField(
        store, ticket.id, 'description', original, storageDir,
      );

      expect(attachment).not.toBeNull();
      const filePath = attachmentPath(storageDir, ticket.id, attachment!.storedName);
      const stored = readFileSync(filePath, 'utf8');
      expect(stored).toBe(original);
    });

    it('registers the spill as a file attachment on the ticket', async () => {
      const ticket = createTicket(store, { key: 'T-5', title: 'register' });
      const content = 'x'.repeat(SPILL_THRESHOLD_CHARS + 1000);
      await spillField(store, ticket.id, 'description', content, storageDir);

      const attachments = listAttachments(store, ticket.id);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.kind).toBe('file');
      expect(attachments[0]!.originalName).toMatch(/spilled-description/);
    });

    it('pointer is bounded regardless of original size', async () => {
      const ticket = createTicket(store, { key: 'T-6', title: 'bound' });
      const huge = 'y'.repeat(2_000_000);
      await spillField(store, ticket.id, 'description', huge, storageDir);

      const fresh = getTicket(store, ticket.id);
      // Pointer is under 200 chars
      expect(fresh.description!.length).toBeLessThan(200);
    });

    it('does not touch other fields when spilling description', async () => {
      const ticket = createTicket(store, { key: 'T-7', title: 'other' });
      updateTicketFields(store, ticket.id, { brief: 'keep me' });
      const content = 'z'.repeat(SPILL_THRESHOLD_CHARS + 100);
      await spillField(store, ticket.id, 'description', content, storageDir);

      const fresh = getTicket(store, ticket.id);
      expect(fresh.brief).toBe('keep me');
    });
  });

  describe('integration: createTicket + spill', () => {
    it('spill at create time replaces oversized description', async () => {
      const ticket = createTicket(store, { key: 'BIG-1', title: 'oversized' });
      const content = 'log '.repeat(500_000);
      const attachment = await spillField(
        store, ticket.id, 'description', content, storageDir,
      );
      expect(attachment).not.toBeNull();

      const fresh = getTicket(store, ticket.id);
      expect(fresh.description!.length).toBeLessThan(200);
      expect(fresh.description).toContain('karst context');
      expect(fresh.description).toContain('BIG-1');
    });
  });

  describe('backfillSpillOversized', () => {
    it('spills all existing oversized descriptions and briefs', async () => {
      const t1 = createTicket(store, {
        key: 'BIG-1', title: 'big desc',
        description: 'x'.repeat(SPILL_THRESHOLD_CHARS + 500),
      });
      const t2 = createTicket(store, {
        key: 'BIG-2', title: 'big brief',
      });
      updateTicketFields(store, t2.id, {
        brief: 'y'.repeat(SPILL_THRESHOLD_CHARS + 300),
      });
      const t3 = createTicket(store, {
        key: 'SMALL', title: 'small',
        description: 'short',
      });

      const warnLogs: string[] = [];
      await backfillSpillOversized(store, storageDir, {
        warn: (msg) => warnLogs.push(msg),
      });

      // Oversized tickets are spilled
      const fresh1 = getTicket(store, t1.id);
      expect(fresh1.description!.length).toBeLessThan(200);
      expect(fresh1.description).toContain('karst context');

      const fresh2 = getTicket(store, t2.id);
      expect(fresh2.brief!.length).toBeLessThan(200);
      expect(fresh2.brief).toContain('karst context');

      // Small ticket is untouched
      const fresh3 = getTicket(store, t3.id);
      expect(fresh3.description).toBe('short');

      // No warnings for successful spills
      expect(warnLogs).toHaveLength(0);
    });

    it('is idempotent — does not re-spill already-spilled tickets', async () => {
      const ticket = createTicket(store, {
        key: 'IDEM', title: 'idem',
        description: 'z'.repeat(SPILL_THRESHOLD_CHARS + 200),
      });
      await spillField(
        store, ticket.id, 'description',
        'z'.repeat(SPILL_THRESHOLD_CHARS + 200), storageDir,
      );

      const before = listAttachments(store, ticket.id);
      expect(before).toHaveLength(1);

      // Run backfill again — should not create a second attachment
      await backfillSpillOversized(store, storageDir, { warn: () => {} });
      const after = listAttachments(store, ticket.id);
      expect(after).toHaveLength(1);
    });
  });
});
