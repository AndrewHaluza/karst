import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planRepeat, storeGreen } from './dockerGate.mjs';

const IDS = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const SCRIPT = 'test:visual:docker';
const ARGV = ['run', '--rm', 'img'];
let dir;
let saved;
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
const put = (name, body) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), body);
};
const commit = (msg) => {
  git(...IDS, 'add', '-A');
  git(...IDS, 'commit', '-qm', msg);
};

beforeEach(() => {
  saved = { ...process.env };
  for (const k of ['KARST_UI_GREP', 'KARST_LAYOUT_SEED', 'KARST_LAYOUT_PRUNE', 'KARST_GATE_FULL']) delete process.env[k];
  process.env.KARST_BASE_REF = 'develop';
  dir = mkdtempSync(join(tmpdir(), 'karst-dgate-'));
  put('src/ui/settings/a.tsx', 'x');
  put('docs/x.md', 'x');
  git('init', '-q', '-b', 'develop');
  commit('base');
  git('checkout', '-qb', 'ticket');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = saved;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const green = async () => storeGreen((await planRepeat(SCRIPT, ARGV, dir)).memo, 0);

describe('planRepeat', () => {
  it('runs the first pass and prints a full line', async () => {
    const r = await planRepeat(SCRIPT, ARGV, dir);
    expect(r.skip).toBeNull();
    expect(r.memo).not.toBeNull();
    expect(console.error).toHaveBeenCalledWith('full: no earlier green run');
  });

  it('skips after a green run when only a non-UI path changed', async () => {
    await green();
    put('docs/x.md', 'changed');
    const r = await planRepeat(SCRIPT, ARGV, dir);
    expect(r.skip).toMatch(/^skipped: no UI change since [0-9a-f]{12}$/);
  });

  it('skips for the layout gate too', async () => {
    storeGreen((await planRepeat('test:layout:docker', ARGV, dir)).memo, 0);
    expect((await planRepeat('test:layout:docker', ARGV, dir)).skip).toMatch(/^skipped:/);
  });

  it('runs when a UI path changed, and says how many paths changed', async () => {
    await green();
    put('src/ui/settings/a.tsx', 'changed');
    const r = await planRepeat(SCRIPT, ARGV, dir);
    expect(r.skip).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^visual: 1 files, delta since [0-9a-f]{12}$/));
  });

  it('stores no green state after a failed run', async () => {
    storeGreen((await planRepeat(SCRIPT, ARGV, dir)).memo, 1);
    put('docs/x.md', 'changed');
    expect((await planRepeat(SCRIPT, ARGV, dir)).skip).toBeNull();
  });

  it('runs when the merge base moved', async () => {
    await green();
    git('checkout', '-q', 'develop');
    put('docs/y.md', 'y');
    commit('develop moves');
    git('checkout', '-q', 'ticket');
    git(...IDS, 'rebase', 'develop');
    expect((await planRepeat(SCRIPT, ARGV, dir)).skip).toBeNull();
    expect(console.error).toHaveBeenCalledWith('full: the merge base moved');
  });

  it('runs with KARST_GATE_FULL=1', async () => {
    await green();
    process.env.KARST_GATE_FULL = '1';
    expect((await planRepeat(SCRIPT, ARGV, dir)).skip).toBeNull();
  });

  it.each(['KARST_LAYOUT_SEED', 'KARST_LAYOUT_PRUNE', 'KARST_UI_GREP'])('never skips or stores with %s set', async (name) => {
    await green();
    process.env[name] = '1';
    expect(await planRepeat(SCRIPT, ARGV, dir)).toEqual({ memo: null, skip: null });
  });

  it('ignores a script that does not narrow', async () => {
    expect(await planRepeat('test:visual:screens:docker', ARGV, dir)).toEqual({ memo: null, skip: null });
  });

  it('keeps the real index and the working tree as they were', async () => {
    await green();
    put('docs/x.md', 'changed');
    const before = git('status', '--porcelain').stdout;
    await planRepeat(SCRIPT, ARGV, dir);
    expect(git('status', '--porcelain').stdout).toBe(before);
  });
});
