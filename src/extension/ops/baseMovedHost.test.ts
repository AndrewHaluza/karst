import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { baseCheckParent, readLastGreenBase, seedMergedState } from './baseMovedHost.js';

const gitDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'base-moved-'));
  mkdirSync(join(dir, 'karst-gate-state'));
  return dir;
};
const state = (dir: string, name: string, body: unknown, mtime: number): void => {
  const path = join(dir, 'karst-gate-state', `${name}.json`);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  utimesSync(path, mtime, mtime);
};

describe('readLastGreenBase', () => {
  it('is null when no gate state exists', async () => {
    expect(await readLastGreenBase(mkdtempSync(join(tmpdir(), 'base-moved-')))).toBeNull();
  });
  it('reads the base of the newest clean state', async () => {
    const dir = gitDir();
    state(dir, 'old', { version: 1, clean: true, base: 'a'.repeat(40) }, 1000);
    state(dir, 'new', { version: 1, clean: true, base: 'b'.repeat(40) }, 2000);
    expect(await readLastGreenBase(dir)).toBe('b'.repeat(40));
  });
  it('ignores a state that was not clean, unreadable, or has no base', async () => {
    const dir = gitDir();
    state(dir, 'red', { version: 1, clean: false, base: 'c'.repeat(40) }, 3000);
    state(dir, 'junk', '{not json', 3000);
    state(dir, 'nobase', { version: 1, clean: true }, 3000);
    state(dir, 'green', { version: 1, clean: true, base: 'd'.repeat(40) }, 1000);
    expect(await readLastGreenBase(dir)).toBe('d'.repeat(40));
  });
});

describe('baseCheckParent', () => {
  it('sits below the nearest ancestor that holds vitest, under .karst/base-check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-root-'));
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    const cwd = join(root, '.karst', 'worktrees', 't1');
    mkdirSync(cwd, { recursive: true });
    expect(await baseCheckParent(cwd)).toBe(join(root, '.karst', 'base-check'));
  });
  it('falls back to the temp directory with no deps root', async () => {
    expect(await baseCheckParent(mkdtempSync(join(tmpdir(), 'no-deps-')), async () => null)).toBe(tmpdir());
  });
});

describe('seedMergedState', () => {
  it('carries the clean states with the base moved to the merged base tip', async () => {
    const from = gitDir();
    state(from, 'green', { version: 1, clean: true, base: 'a'.repeat(40), tree: 't1', failed: ['x.test.ts'] }, 1000);
    state(from, 'red', { version: 1, clean: false, base: 'a'.repeat(40), tree: 't2', failed: [] }, 1000);
    state(from, 'junk', '{not json', 1000);
    const to = mkdtempSync(join(tmpdir(), 'base-moved-to-'));
    expect(await seedMergedState(from, to, 'b'.repeat(40))).toBe(1);
    const seeded = JSON.parse(readFileSync(join(to, 'karst-gate-state', 'green.json'), 'utf8'));
    expect(seeded).toEqual({ version: 1, clean: true, base: 'b'.repeat(40), tree: 't1', failed: ['x.test.ts'] });
    expect(() => readFileSync(join(to, 'karst-gate-state', 'red.json'))).toThrow();
  });
  it('seeds nothing when the ticket worktree has no gate state', async () => {
    expect(await seedMergedState(mkdtempSync(join(tmpdir(), 'base-moved-')), mkdtempSync(join(tmpdir(), 'base-moved-to-')), 'b'.repeat(40))).toBe(0);
  });
});
