import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { baseCheckParent, findDepsRoot, readLastGreenBase, seedMergedState } from './baseMovedHost.js';

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

describe('readLastGreenBase state filters', () => {
  const clean = { version: 1, clean: true };
  it('is null when every state is invalid, so no baseline is claimed', async () => {
    const dir = gitDir();
    state(dir, 'v2', { ...clean, version: 2, base: 'a'.repeat(40) }, 1000);
    state(dir, 'empty', { ...clean, base: '' }, 1000);
    state(dir, 'num', { ...clean, base: 5 }, 1000);
    state(dir, 'nul', 'null', 1000);
    state(dir, 'str', '"text"', 1000);
    state(dir, 'notclean', { version: 1, clean: 'yes', base: 'a'.repeat(40) }, 1000);
    expect(await readLastGreenBase(dir)).toBeNull();
  });
  it('reads only .json files', async () => {
    const dir = gitDir();
    writeFileSync(join(dir, 'karst-gate-state', 'newer.txt'), JSON.stringify({ ...clean, base: 'e'.repeat(40) }));
    state(dir, 'a-old', { ...clean, base: 'a'.repeat(40) }, 1000);
    utimesSync(join(dir, 'karst-gate-state', 'newer.txt'), 9000, 9000);
    expect(await readLastGreenBase(dir)).toBe('a'.repeat(40));
  });
  it('picks the newest state whatever the file name order', async () => {
    const dir = gitDir();
    state(dir, 'a-new', { ...clean, base: 'a'.repeat(40) }, 2000);
    state(dir, 'b-old', { ...clean, base: 'b'.repeat(40) }, 1000);
    state(dir, 'c-oldest', { ...clean, base: 'c'.repeat(40) }, 500);
    expect(await readLastGreenBase(dir)).toBe('a'.repeat(40));
    const later = gitDir();
    state(later, 'a-old', { ...clean, base: 'a'.repeat(40) }, 1000);
    state(later, 'b-new', { ...clean, base: 'b'.repeat(40) }, 2000);
    expect(await readLastGreenBase(later)).toBe('b'.repeat(40));
  });
});

describe('findDepsRoot', () => {
  it('skips a node_modules without vitest and returns the nearest ancestor that holds it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-find-'));
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    const inner = join(root, 'pkg');
    mkdirSync(join(inner, 'node_modules'), { recursive: true });
    expect(await findDepsRoot(inner)).toBe(root);
  });
  it('is null when no ancestor holds vitest', async () => {
    expect(await findDepsRoot(mkdtempSync(join(tmpdir(), 'deps-none-')))).toBeNull();
  });
});

describe('baseCheckParent directory creation', () => {
  it('creates a missing .karst directory and tolerates an existing base-check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-root2-'));
    const parent = await baseCheckParent(root, async () => root);
    expect(parent).toBe(join(root, '.karst', 'base-check'));
    expect(await baseCheckParent(root, async () => root)).toBe(parent);
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
  it('copies the Stryker incremental file as it is, without counting it as a gate state', async () => {
    const from = gitDir();
    writeFileSync(join(from, 'karst-gate-state', 'stryker-lines.json'), '{"mutants":[1]}');
    const to = mkdtempSync(join(tmpdir(), 'base-moved-to-'));
    expect(await seedMergedState(from, to, 'b'.repeat(40))).toBe(0);
    expect(readFileSync(join(to, 'karst-gate-state', 'stryker-lines.json'), 'utf8')).toBe('{"mutants":[1]}');
  });
  it('creates a missing target directory chain and skips files that are not .json', async () => {
    const from = gitDir();
    writeFileSync(join(from, 'karst-gate-state', 'note.txt'), JSON.stringify({ version: 1, clean: true, base: 'a' }));
    state(from, 'green', { version: 1, clean: true, base: 'a'.repeat(40) }, 1000);
    state(from, 'nul', 'null', 1000);
    state(from, 'v2', { version: 2, clean: true, base: 'a' }, 1000);
    state(from, 'dirty', { version: 1, clean: 'no', base: 'a' }, 1000);
    const to = join(mkdtempSync(join(tmpdir(), 'base-moved-to-')), 'nested', 'git');
    expect(await seedMergedState(from, to, 'b'.repeat(40))).toBe(1);
    expect(() => readFileSync(join(to, 'karst-gate-state', 'note.txt'))).toThrow();
    expect(() => readFileSync(join(to, 'karst-gate-state', 'nul.json'))).toThrow();
    expect(() => readFileSync(join(to, 'karst-gate-state', 'v2.json'))).toThrow();
    expect(() => readFileSync(join(to, 'karst-gate-state', 'dirty.json'))).toThrow();
  });
  it('seeds nothing when the ticket worktree has no gate state', async () => {
    expect(await seedMergedState(mkdtempSync(join(tmpdir(), 'base-moved-')), mkdtempSync(join(tmpdir(), 'base-moved-to-')), 'b'.repeat(40))).toBe(0);
  });
});
