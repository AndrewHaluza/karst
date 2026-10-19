import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bridgePaths } from './bridgeDir.js';
import { InboxTamperedError, writeInboxFile } from './inbox.js';

const root = mkdtempSync(join(tmpdir(), 'karst-inbox-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const paths = bridgePaths(join(root, String(++n)), 7);
  mkdirSync(paths.dir, { recursive: true });
  return paths;
};

describe('writeInboxFile', () => {
  it('creates the inbox and writes <ref>.md', async () => {
    const paths = fresh();
    const written = await writeInboxFile(paths, 'fix-12', 'brief');
    expect(written).toBe(join(paths.inboxDir, 'fix-12.md'));
    expect(readFileSync(written, 'utf8')).toBe('brief');
  });

  it('a rewrite replaces an agent-planted file (rename over it, no O_EXCL loop)', async () => {
    const paths = fresh();
    await writeInboxFile(paths, 'fix-1', 'one');
    rmSync(join(paths.inboxDir, 'fix-1.md'));
    symlinkSync('/etc/passwd', join(paths.inboxDir, 'fix-1.md'));
    await writeInboxFile(paths, 'fix-1', 'two');
    expect(lstatSync(join(paths.inboxDir, 'fix-1.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(paths.inboxDir, 'fix-1.md'), 'utf8')).toBe('two');
    expect(readdirSync(paths.inboxDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a symlinked inbox/ is rejected and recreated as a real dir; the next write works', async () => {
    const paths = fresh();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, paths.inboxDir);
    await expect(writeInboxFile(paths, 'fix-1', 'x')).rejects.toBeInstanceOf(InboxTamperedError);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(paths.inboxDir).isDirectory()).toBe(true);
    await expect(writeInboxFile(paths, 'fix-1', 'x')).resolves.toContain('fix-1.md');
  });

  it('a file where the inbox dir belongs is rejected and recreated', async () => {
    const paths = fresh();
    writeFileSync(paths.inboxDir, 'not a dir');
    await expect(writeInboxFile(paths, 'fix-1', 'x')).rejects.toBeInstanceOf(InboxTamperedError);
    expect(existsSync(join(paths.inboxDir))).toBe(true);
    expect(lstatSync(paths.inboxDir).isDirectory()).toBe(true);
  });

  it('rejects a ref that is not a token', async () => {
    await expect(writeInboxFile(fresh(), '../escape', 'x')).rejects.toThrow('invalid inbox ref');
  });
});
