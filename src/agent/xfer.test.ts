import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openXfer, withXfer } from './xfer.js';

const root = mkdtempSync(join(tmpdir(), 'karst-xfer-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('xfer', () => {
  it('writes through temp + rename and returns the host-built path', async () => {
    await withXfer(async (x) => {
      const p = await x.write('out.bundle', Buffer.from('hi'));
      expect(p).toBe(join(x.dir, 'out.bundle'));
      expect(readFileSync(p, 'utf8')).toBe('hi');
      await expect(x.verified('out.bundle')).resolves.toBe(p);
    });
  });

  it('refuses a symlinked xfer dir', async () => {
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    await expect(openXfer(join(root, 'link'))).rejects.toThrow('not a real directory');
  });

  it('refuses a symlinked or foreign-type bundle file', async () => {
    const dir = join(root, 'd');
    mkdirSync(dir);
    writeFileSync(join(root, 'secret'), 's');
    symlinkSync(join(root, 'secret'), join(dir, 'out.bundle'));
    mkdirSync(join(dir, 'sub'));
    const x = await openXfer(dir);
    await expect(x.verified('out.bundle')).rejects.toThrow('not a regular file');
    await expect(x.verified('sub')).rejects.toThrow('not a regular file');
  });

  it('rejects unsafe names (no separators or traversal)', async () => {
    await withXfer(async (x) => {
      await expect(x.write('../x', Buffer.from('a'))).rejects.toThrow('unsafe file name');
      await expect(x.verified('a/b')).rejects.toThrow('unsafe file name');
    });
  });
});
