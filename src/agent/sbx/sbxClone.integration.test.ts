import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NODE_SBX_PROCESS } from './sbxProcess.js';
import { prepareSbxClone, removeSbxClone, sbxCloneDir } from './sbxClone.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'karst-sbxclone-')));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
    await expect(prepareSbxClone(NODE_SBX_PROCESS, { worktree: wt, branch: 'ticket', dir })).resolves.toEqual({ ok: true });
    await removeSbxClone(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it.skipIf(spawnSync('sbx', ['version']).status !== 0)('sbx accepts the clone where it rejects the worktree', () => {
    const wt = join(root, 'wt');
    const rejected = spawnSync('sbx', ['run', '--clone', '--name', 'karst-fixture-wt', 'claude', wt, '--detach'], { encoding: 'utf8' });
    expect(`${rejected.stderr}${rejected.stdout}`).toContain('not supported when run from a Git worktree');
  });
});
