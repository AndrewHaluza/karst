import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PASTE_BYTES, ingestFile, ingestBytes } from './ingest.js';
import { attachmentDir, attachmentPath } from './paths.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshStorage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-attach-'));
  dirs.push(dir);
  return dir;
}

function sourceFile(name: string, contents: string): string {
  const dir = freshStorage();
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('ingestBytes', () => {
  it('writes the bytes under a content-addressed name and returns the row input', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'login-error.png', Buffer.from('PNGDATA'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({
      ticketId: 12,
      kind: 'image',
      originalName: 'login-error.png',
      byteSize: 7,
    });
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.png$/);
    const written = attachmentPath(storage, 12, result.input.storedName);
    expect(readFileSync(written, 'utf8')).toBe('PNGDATA');
  });

  it('creates the ticket directory when it does not exist yet', async () => {
    const storage = freshStorage();
    expect(existsSync(attachmentDir(storage, 3))).toBe(false);
    const result = await ingestBytes(storage, 3, 'a.png', Buffer.from('x'));
    expect(result.ok).toBe(true);
    expect(existsSync(attachmentDir(storage, 3))).toBe(true);
  });

  it('gives identical bytes the same stored name', async () => {
    const storage = freshStorage();
    const a = await ingestBytes(storage, 12, 'one.png', Buffer.from('SAME'));
    const b = await ingestBytes(storage, 12, 'two.png', Buffer.from('SAME'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.input.storedName).toBe(b.input.storedName);
  });

  it('publishes identical pasted bytes once without rewriting the destination', async () => {
    const storage = freshStorage();
    const first = await ingestBytes(storage, 12, 'one.png', Buffer.from('SAME'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const destination = attachmentPath(storage, 12, first.input.storedName);
    utimesSync(destination, 1, 1);

    const second = await ingestBytes(storage, 12, 'two.png', Buffer.from('SAME'));

    expect(second.ok).toBe(true);
    expect(statSync(destination).mtimeMs).toBe(1000);
    expect(readdirSync(attachmentDir(storage, 12))).toEqual([first.input.storedName]);
  });

  it('gives different bytes different stored names', async () => {
    const storage = freshStorage();
    const a = await ingestBytes(storage, 12, 'x.png', Buffer.from('ONE'));
    const b = await ingestBytes(storage, 12, 'x.png', Buffer.from('TWO'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.input.storedName).not.toBe(b.input.storedName);
  });

  it('rejects a name with no accepted extension', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'README', Buffer.from('data'));
    expect(result).toEqual({
      ok: false,
      message: 'README is not a supported attachment (images: png, jpg, jpeg, gif, webp; video: mp4, webm, mov; any other file)',
    });
  });

  it('stores pasted text bytes as a file attachment', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'pasted.txt', Buffer.from('hello'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.kind).toBe('file');
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.txt$/);
  });

  it('rejects bytes over the paste cap with a named reason', async () => {
    const storage = freshStorage();
    const tooBig = Buffer.alloc(MAX_PASTE_BYTES + 1);
    const result = await ingestBytes(storage, 12, 'huge.png', tooBig);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('too large to paste');
    expect(result.message).toContain('Attach');
  });

  it('accepts bytes exactly at the cap', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'edge.png', Buffer.alloc(MAX_PASTE_BYTES));
    expect(result.ok).toBe(true);
  });

  it('never lets a traversal-shaped original name reach the path', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, '../../../evil.png', Buffer.from('x'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(result.input.originalName).toBe('../../../evil.png');
    expect(existsSync(attachmentPath(storage, 12, result.input.storedName))).toBe(true);
    expect(existsSync(join(storage, '..', '..', '..', 'evil.png'))).toBe(false);
  });
});

describe('ingestFile', () => {
  it('copies the file under a content-addressed name', async () => {
    const storage = freshStorage();
    const src = sourceFile('repro.mov', 'MOVDATA');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({
      ticketId: 5,
      kind: 'video',
      originalName: 'repro.mov',
      byteSize: 7,
    });
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.mov$/);
    expect(readFileSync(attachmentPath(storage, 5, result.input.storedName), 'utf8')).toBe('MOVDATA');
  });

  it('leaves the source file in place', async () => {
    const storage = freshStorage();
    const src = sourceFile('keep.png', 'DATA');
    await ingestFile(storage, 5, src);
    expect(existsSync(src)).toBe(true);
  });

  it('keeps an existing matching content-addressed file in place', async () => {
    const storage = freshStorage();
    const src = sourceFile('repro.mov', 'MOVDATA');
    const storedName = '0474ed9cf8746f82.mov';
    const existing = attachmentPath(storage, 5, storedName);
    mkdirSync(attachmentDir(storage, 5), { recursive: true });
    writeFileSync(existing, 'MOVDATA');
    chmodSync(existing, 0o444);

    const result = await ingestFile(storage, 5, src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.storedName).toBe(storedName);
    expect(readFileSync(existing, 'utf8')).toBe('MOVDATA');
  });

  it('does not republish changed picker contents under the original content address', async () => {
    const storage = freshStorage();
    const src = sourceFile('repro.mov', 'ORIGINAL');
    const first = await ingestFile(storage, 5, src);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    rmSync(attachmentPath(storage, 5, first.input.storedName));
    writeFileSync(src, 'CHANGED');

    const retry = await ingestFile(storage, 5, src, first.input.storedName);

    expect(retry).toEqual({
      ok: false,
      message: 'repro.mov changed before it could be saved',
    });
    expect(readdirSync(attachmentDir(storage, 5))).toEqual([]);
  });

  it('rejects a name with no accepted extension', async () => {
    const storage = freshStorage();
    const src = sourceFile('README', 'data');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not a supported attachment');
  });

  it('stores a picked pdf as a file attachment', async () => {
    const storage = freshStorage();
    const src = sourceFile('notes.pdf', '%PDF');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({ kind: 'file', originalName: 'notes.pdf' });
  });

  it('accepts a file larger than the paste cap', async () => {
    const storage = freshStorage();
    const dir = freshStorage();
    const src = join(dir, 'big.mp4');
    writeFileSync(src, Buffer.alloc(MAX_PASTE_BYTES + 1024));
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(true);
  });

  it('reports a missing source file as a reason, not a throw', async () => {
    const storage = freshStorage();
    const result = await ingestFile(storage, 5, join(storage, 'nope.png'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('could not be read');
  });
});
