import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffTrees, gitDirOf, loadPassInput, planScope, readState, snapshotTree, writeState } from './gateState.mjs';

describe('state files and snapshots', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const sh = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const init = () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-gstate-'));
    sh('init', '-q', '-b', 'develop');
    writeFileSync(join(dir, '.gitignore'), 'ignored\n');
    writeFileSync(join(dir, 'a.txt'), 'a');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
  };

  it('round-trips a state and reads a missing, corrupt or old one as not usable', async () => {
    init();
    const gd = await gitDirOf(dir);
    expect(readState(gd, 'k')).toEqual({ state: null, readable: true });
    writeState(gd, 'k', { tree: 'a'.repeat(40), base: 'b', clean: true, failed: ['x'] });
    expect(readState(gd, 'k').state).toMatchObject({ tree: 'a'.repeat(40), failed: ['x'] });
    writeFileSync(join(gd, 'karst-gate-state', 'k.json'), '{nope');
    expect(readState(gd, 'k')).toEqual({ state: null, readable: false });
    writeFileSync(join(gd, 'karst-gate-state', 'k.json'), JSON.stringify({ version: 0, tree: 't', failed: [], clean: true }));
    expect(readState(gd, 'k').readable).toBe(false);
  });

  it('snapshots tracked, modified and untracked files, skips ignored ones, and leaves the index and tree alone', async () => {
    init();
    writeFileSync(join(dir, 'a.txt'), 'changed');
    writeFileSync(join(dir, 'new.txt'), 'n');
    writeFileSync(join(dir, 'ignored'), 'i');
    const gd = await gitDirOf(dir);
    const indexHash = () => createHash('sha1').update(readFileSync(join(gd, 'index'))).digest('hex');
    const before = { index: indexHash(), status: sh('status', '--porcelain').stdout, files: readdirSync(dir).sort() };
    const tree = await snapshotTree(dir);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect({ index: indexHash(), status: sh('status', '--porcelain').stdout, files: readdirSync(dir).sort() }).toEqual(before);
    expect(readdirSync(gd).filter((f) => f.startsWith('karst-gate-index'))).toEqual([]);
    const names = sh('ls-tree', '-r', '--name-only', tree).stdout.split('\n').filter(Boolean);
    expect(names).toEqual(['.gitignore', 'a.txt', 'new.txt']);
  });

  it('diffs two trees and reports a deletion', async () => {
    init();
    const t1 = await snapshotTree(dir);
    writeFileSync(join(dir, 'b.txt'), 'b');
    writeFileSync(join(dir, 'a.txt'), 'x');
    rmSync(join(dir, '.gitignore'));
    const t2 = await snapshotTree(dir);
    const delta = await diffTrees(dir, t1, t2);
    expect(delta.sort((p, q) => p.path.localeCompare(q.path))).toEqual([
      { status: 'D', path: '.gitignore' },
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'b.txt' },
    ]);
  });

  it('loadPassInput marks a missing snapshot object unreadable', async () => {
    init();
    const gd = await gitDirOf(dir);
    writeState(gd, 'k', { tree: 'c'.repeat(40), base: 'b', clean: true, failed: [] });
    const now = await snapshotTree(dir);
    const input = await loadPassInput(dir, gd, 'k', 'b', now);
    expect(input.readable).toBe(false);
    expect(planScope({ ...input }).kind).toBe('full');
    expect(existsSync(join(gd, 'index'))).toBe(true);
  });

  it('loadPassInput diffs a stored snapshot against now', async () => {
    init();
    const gd = await gitDirOf(dir);
    const t1 = await snapshotTree(dir);
    writeState(gd, 'k', { tree: t1, base: 'b', clean: true, failed: [] });
    writeFileSync(join(dir, 'a.txt'), 'zzz');
    const input = await loadPassInput(dir, gd, 'k', 'b', await snapshotTree(dir));
    expect(input.delta).toEqual([{ status: 'M', path: 'a.txt' }]);
  });
});
