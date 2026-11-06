import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFixtures } from './buildFixture.js';
import { cleanTmpAfterRun, KEEP_TMP_ENV } from './tmpCleanup.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fakeTmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-tmpclean-'));
  roots.push(root);
  const dir = join(root, '.tmp');
  mkdirSync(join(dir, 'dark'), { recursive: true });
  writeFileSync(join(dir, 'dark', 'x.html'), 'page');
  return dir;
}

describe('cleanTmpAfterRun', () => {
  it('removes the pages after a passed run', () => {
    const dir = fakeTmp();
    expect(cleanTmpAfterRun('passed', dir, {})).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(['failed', 'timedout', 'interrupted'])('keeps the pages after a %s run, for diagnosis', (status) => {
    const dir = fakeTmp();
    expect(cleanTmpAfterRun(status, dir, {})).toBe(false);
    expect(existsSync(join(dir, 'dark', 'x.html'))).toBe(true);
  });

  it('keeps the pages when the keep variable is set', () => {
    const dir = fakeTmp();
    expect(cleanTmpAfterRun('passed', dir, { [KEEP_TMP_ENV]: '1' })).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('does not fail when the directory is already gone', () => {
    const dir = fakeTmp();
    rmSync(dir, { recursive: true });
    expect(() => cleanTmpAfterRun('passed', dir, {})).not.toThrow();
  });
});

describe('writeFixtures', () => {
  it('clears pages left by an earlier (failed) run before it writes', () => {
    const dir = fakeTmp();
    writeFileSync(join(dir, 'dark', 'stale-view.html'), 'stale');
    writeFixtures(dir);
    expect(existsSync(join(dir, 'dark', 'stale-view.html'))).toBe(false);
    expect(existsSync(join(dir, 'catalog.html'))).toBe(true);
  });
});
