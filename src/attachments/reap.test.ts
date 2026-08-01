import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discardStagedAttachment,
  reapAttachments,
  restoreStagedAttachment,
  stageAttachmentRemoval,
  unlinkAttachment,
} from './reap.js';
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

describe('staged attachment removal', () => {
  it('can restore a file after moving it out of its published path', async () => {
    const storage = storageWithFile(12, 'a.png');
    const destination = attachmentPath(storage, 12, 'a.png');

    const staged = await stageAttachmentRemoval(storage, 12, 'a.png');
    expect(staged).not.toBeNull();
    expect(existsSync(destination)).toBe(false);

    await restoreStagedAttachment(staged);
    expect(readFileSync(destination, 'utf8')).toBe('DATA');
    expect(readdirSync(attachmentDir(storage, 12))).toEqual(['a.png']);
  });

  it('never overwrites bytes a concurrent attach published before restore', async () => {
    const storage = storageWithFile(12, 'a.png');
    const destination = attachmentPath(storage, 12, 'a.png');
    const staged = await stageAttachmentRemoval(storage, 12, 'a.png');
    writeFileSync(destination, 'NEW DATA');

    await restoreStagedAttachment(staged);

    expect(readFileSync(destination, 'utf8')).toBe('NEW DATA');
    expect(readdirSync(attachmentDir(storage, 12))).toEqual(['a.png']);
  });

  it('discards the staged link only after publication has moved aside', async () => {
    const storage = storageWithFile(12, 'a.png');
    const staged = await stageAttachmentRemoval(storage, 12, 'a.png');

    await discardStagedAttachment(staged);

    expect(readdirSync(attachmentDir(storage, 12))).toEqual([]);
  });

  it('rediscovers a retained staged file from the persisted detach token', async () => {
    const storage = storageWithFile(12, 'a.png');
    const token = 'detach:123:11111111-2222-3333-4444-555555555555';
    const first = await stageAttachmentRemoval(storage, 12, 'a.png', token);

    const resumed = await stageAttachmentRemoval(storage, 12, 'a.png', token);

    expect(resumed).toEqual(first);
    await discardStagedAttachment(resumed);
    expect(readdirSync(attachmentDir(storage, 12))).toEqual([]);
  });

  it('rejects a directory instead of recursively deleting it', async () => {
    const storage = storageWithFile(12, 'a.png');
    const directory = attachmentPath(storage, 12, 'folder.png');
    mkdirSync(directory);

    await expect(stageAttachmentRemoval(storage, 12, 'folder.png')).rejects.toThrow(/directory/);
    expect(existsSync(directory)).toBe(true);
  });
});
