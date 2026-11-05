import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTranscriptReader, MAX_TRANSCRIPT_BYTES } from './claudeTranscriptRead.js';

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-tread-'));
  root = join(dir, 'bridge');
  mkdirSync(join(root, 'p'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('makeTranscriptReader', () => {
  it('reads a regular file under the root', async () => {
    const f = join(root, 'p', 's.jsonl');
    writeFileSync(f, 'abc');
    const r = makeTranscriptReader(root);
    expect((await r.stat(f)).size).toBe(3);
    expect(await r.readFile(f)).toBe('abc');
  });

  it('refuses a symlinked file', async () => {
    const secret = join(dir, 'secret.jsonl');
    writeFileSync(secret, 'x');
    const f = join(root, 'p', 's.jsonl');
    symlinkSync(secret, f);
    const r = makeTranscriptReader(root);
    await expect(r.stat(f)).rejects.toThrow();
    await expect(r.readFile(f)).rejects.toThrow();
  });

  it('refuses a path that leaves the root through a linked directory', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 's.jsonl'), 'x');
    symlinkSync(outside, join(root, 'linked'));
    const f = join(root, 'linked', 's.jsonl');
    const r = makeTranscriptReader(root);
    await expect(r.stat(f)).rejects.toThrow(/outside/);
    await expect(r.readFile(f)).rejects.toThrow(/outside/);
  });

  it('refuses a directory (not a regular file)', async () => {
    const r = makeTranscriptReader(root);
    await expect(r.stat(join(root, 'p'))).rejects.toThrow(/regular/);
  });

  it('refuses a file over the size cap', async () => {
    const f = join(root, 'p', 'big.jsonl');
    writeFileSync(f, Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1));
    const r = makeTranscriptReader(root);
    await expect(r.stat(f)).rejects.toThrow(/too large/);
    await expect(r.readFile(f)).rejects.toThrow(/too large/);
  });

  it('keeps a missing file as ENOENT', async () => {
    const r = makeTranscriptReader(root);
    await expect(r.stat(join(root, 'p', 'none'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('without a root still refuses a symlink and reads a regular file', async () => {
    const f = join(dir, 'h.jsonl');
    writeFileSync(f, 'h');
    symlinkSync(f, join(dir, 'l.jsonl'));
    const r = makeTranscriptReader();
    expect(await r.readFile(f)).toBe('h');
    await expect(r.readFile(join(dir, 'l.jsonl'))).rejects.toThrow();
  });
});
