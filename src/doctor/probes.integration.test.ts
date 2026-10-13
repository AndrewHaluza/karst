import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from './probes.js';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
};
let root: string;
let repo: string;
let remote: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'doctor-probes-'));
  remote = join(root, 'remote.git');
  repo = join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('doctor probes (real git)', () => {
  it('detects repos, branches, paths', () => {
    expect(p.isGitRepo(repo)).toBe(true);
    expect(p.isGitRepo(root)).toBe(false);
    expect(p.branchExists(repo, 'main')).toBe(true);
    expect(p.branchExists(repo, 'nope')).toBe(false);
    expect(p.pathExists(repo)).toBe(true);
    expect(p.pathExists(join(root, 'x'))).toBe(false);
  });

  it('worktreeState: unknown without upstream, clean when pushed, dirty when edited or ahead', () => {
    expect(p.worktreeState(repo)).toBe('unknown');
    git(repo, 'push', '-u', 'origin', 'main');
    expect(p.worktreeState(repo)).toBe('clean');
    writeFileSync(join(repo, 'b.txt'), 'b');
    expect(p.worktreeState(repo)).toBe('dirty');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'ahead');
    expect(p.worktreeState(repo)).toBe('dirty'); // committed but unpushed
    expect(p.worktreeState(join(root, 'missing'))).toBe('unknown');
  });

  it('process probes see this process, not an absent pid', () => {
    expect(p.pidAlive(process.pid)).toBe(true);
    expect(p.pidAlive(2147483646)).toBe(false);
    const started = p.pidStartedAtMs(process.pid);
    expect(started).toBeDefined();
    expect(started!).toBeLessThanOrEqual(Date.now());
    expect(p.pidStartedAtMs(2147483646)).toBeUndefined();
  });

  it('resolves binaries, versions and file sizes', () => {
    expect(p.binaryResolves('git')).toBe(true);
    expect(p.binaryResolves('definitely-not-a-binary-xyz')).toBe(false);
    expect(p.binaryResolves(process.execPath)).toBe(true);
    expect(p.toolVersion('git')).toMatch(/git version/);
    expect(p.toolVersion('definitely-not-a-binary-xyz')).toBeUndefined();
    expect(p.fileBytes(join(repo, 'a.txt'))).toBe(1);
    expect(p.fileBytes(join(root, 'none'))).toBe(0);
    expect(p.listeningPids(1)).toEqual([]);
  });

  it('resolveCommand returns the on-PATH path, realpath follows a symlink', () => {
    expect(p.resolveCommand('git')).toMatch(/git$/);
    expect(p.resolveCommand('definitely-not-a-binary-xyz')).toBeUndefined();
    expect(p.resolveCommand(process.execPath)).toBe(process.execPath);
    expect(p.resolveCommand(join(root, 'none'))).toBeUndefined();

    const link = join(root, 'claude');
    execFileSync('ln', ['-sfn', join(repo, 'a.txt'), link]);
    expect(p.realpath(link)).toBe(p.realpath(join(repo, 'a.txt')));
    expect(p.realpath(join(root, 'none'))).toBeUndefined();
    expect(p.linkExists(link)).toBe(true);
    expect(p.readLink(link)).toBe(join(repo, 'a.txt'));
    expect(p.readLink(join(repo, 'a.txt'))).toBeUndefined();

    // A DANGLING link: `existsSync`/`realpath` say no, but the entry is there
    // and its raw target is readable — the post-cleanup state doctor must see.
    const dangling = join(root, 'dangling');
    execFileSync('ln', ['-sfn', join(root, 'gone'), dangling]);
    expect(p.pathExists(dangling)).toBe(false);
    expect(p.realpath(dangling)).toBeUndefined();
    expect(p.linkExists(dangling)).toBe(true);
    expect(p.readLink(dangling)).toBe(join(root, 'gone'));
    expect(p.linkExists(join(root, 'none'))).toBe(false);
  });

  it('reads maxUserWatches from a proc file or returns undefined', () => {
    const procFile = join(root, 'max_user_watches');
    writeFileSync(procFile, '524288\n');
    expect(p.maxUserWatches(procFile)).toBe(524288);
    expect(p.maxUserWatches(join(root, 'nonexistent'))).toBeUndefined();

    const invalidFile = join(root, 'invalid_watches');
    writeFileSync(invalidFile, 'not-a-number');
    expect(p.maxUserWatches(invalidFile)).toBeUndefined();
  });

  it('sums inotify watches across the uid\'s processes, skipping other uids and non-pid dirs', () => {
    const proc = join(root, 'proc');
    const wd = (n: number) => Array.from({ length: n }, (_, k) => `inotify wd:${k + 1} ino:1 sdev:1 mask:1`).join('\n') + '\n';
    const mk = (pid: string, fds: Record<string, string>) => {
      const d = join(proc, pid, 'fdinfo');
      mkdirSync(d, { recursive: true });
      for (const [fd, c] of Object.entries(fds)) writeFileSync(join(d, fd), c);
    };
    mk('100', { '0': 'pos:\t0\n', '3': wd(3) });
    mk('200', { '4': wd(2) });
    mk('self', { '3': wd(50) });
    const uid = process.getuid!();
    expect(p.countInotifyWatches(proc, uid)).toBe(5);
    expect(p.countInotifyWatches(proc, uid + 1)).toBeUndefined();
    expect(p.countInotifyWatches(join(root, 'nonexistent_proc'), uid)).toBeUndefined();
  });

  it('returns undefined when no fdinfo is readable', () => {
    const proc = join(root, 'proc-empty');
    mkdirSync(join(proc, '300'), { recursive: true });
    expect(p.countInotifyWatches(proc, process.getuid!())).toBeUndefined();
  });
});
