import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapAttachments, unlinkAttachment } from './reap.js';
import { attachmentDir, attachmentPath } from './paths.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storageWithFile(ticketId: number, storedName: string): string {
  const storage = mkdtempSync(join(tmpdir(), 'karst-reap-'));
  dirs.push(storage);
  mkdirSync(attachmentDir(storage, ticketId), { recursive: true });
  writeFileSync(attachmentPath(storage, ticketId, storedName), 'DATA');
  return storage;
}

describe('reapAttachments', () => {
  it('removes the ticket directory and everything in it', async () => {
    const storage = storageWithFile(12, 'a.png');
    await reapAttachments(storage, 12);
    expect(existsSync(attachmentDir(storage, 12))).toBe(false);
  });

  it("leaves other tickets' directories alone", async () => {
    const storage = storageWithFile(12, 'a.png');
    mkdirSync(attachmentDir(storage, 13), { recursive: true });
    await reapAttachments(storage, 12);
    expect(existsSync(attachmentDir(storage, 13))).toBe(true);
  });

  it('is a no-op when the directory does not exist', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'karst-reap-'));
    dirs.push(storage);
    await expect(reapAttachments(storage, 99)).resolves.toBeUndefined();
  });
});

describe('unlinkAttachment', () => {
  it('removes one stored file', async () => {
    const storage = storageWithFile(12, 'a.png');
    await unlinkAttachment(storage, 12, 'a.png');
    expect(existsSync(attachmentPath(storage, 12, 'a.png'))).toBe(false);
    expect(existsSync(attachmentDir(storage, 12))).toBe(true);
  });

  it('is a no-op when the file is already gone', async () => {
    const storage = storageWithFile(12, 'a.png');
    await expect(unlinkAttachment(storage, 12, 'missing.png')).resolves.toBeUndefined();
  });
});
