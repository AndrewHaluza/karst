import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NODE_SBX_PROCESS } from './sbxProcess.js';
import { prepareSbxClone, removeSbxClone, sbxCloneDir } from './sbxClone.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-sbxclone-')));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function dirBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    const p = join(dir, e.name);
    return sum + (e.isDirectory() ? dirBytes(p) : statSync(p).size);
  }, 0);
}

describe('prepareSbxClone with a real linked worktree', () => {
  it('builds a standalone clone of the ticket branch: own .git, no origin', async () => {
    const main = join(root, 'main');
    execFileSync('git', ['init', '-q', main]);
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'ticket', wt);
    const dir = sbxCloneDir(root, 'n1');
    await expect(prepareSbxClone(NODE_SBX_PROCESS, { worktree: wt, branch: 'ticket', dir })).resolves.toEqual({ ok: true });
    expect(existsSync(join(dir, '.git', 'HEAD'))).toBe(true);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('ticket');
    expect(git(dir, 'remote').trim()).toBe('');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'next');
    await expect(prepareSbxClone(NODE_SBX_PROCESS, { worktree: wt, branch: 'ticket', dir })).resolves.toEqual({ ok: true });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(wt, 'rev-parse', 'HEAD'));
    await removeSbxClone(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('copies only reachable objects: an unreachable pack in the source stays out of the clone', async () => {
    const main = join(root, 'big-main');
    execFileSync('git', ['init', '-q', main]);
    git(main, ...ID, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'checkout', '-q', '-b', 'junk');
    writeFileSync(join(main, 'big.bin'), randomBytes(3_000_000));
    git(main, 'add', '-A');
    git(main, ...ID, 'commit', '-q', '-m', 'big');
    git(main, 'repack', '-q', '-a', '-d');
    git(main, 'checkout', '-q', '-');
    git(main, 'branch', '-q', '-D', 'junk');
    git(main, 'reflog', 'expire', '--expire=now', '--all');
    const wt = join(root, 'big-wt');
    git(main, 'worktree', 'add', '-q', '-b', 'ticket', wt);
    const dir = sbxCloneDir(root, 'n-big');
    await expect(prepareSbxClone(NODE_SBX_PROCESS, { worktree: wt, branch: 'ticket', dir })).resolves.toEqual({ ok: true });
    expect(dirBytes(join(dir, '.git', 'objects'))).toBeLessThan(1_000_000);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('ticket');
    expect(git(dir, 'remote').trim()).toBe('');
    expect(git(dir, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/ticket');
    await removeSbxClone(dir);
  });

  it.skipIf(spawnSync('sbx', ['version']).status !== 0)('sbx accepts the clone where it rejects the worktree', (ctx) => {
    const wt = join(root, 'wt');
    const rejected = spawnSync('sbx', ['run', '--clone', '--name', 'karst-fixture-wt', 'claude', wt, '--detach'], { encoding: 'utf8' });
    const output = `${rejected.stderr}${rejected.stdout}`;
    if (output.includes('not signed in')) ctx.skip(); // sbx is installed but not logged in on this host: it never reaches the worktree check
    expect(output).toContain('not supported when run from a Git worktree');
  });
});
