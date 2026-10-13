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

  it('counts inotify watches across fdinfo files or returns undefined', () => {
    const fakeFdinfo = join(root, 'fdinfo');
    mkdirSync(fakeFdinfo, { recursive: true });

    // File 1: not inotify (e.g. regular file fd)
    writeFileSync(join(fakeFdinfo, '0'), 'pos:\t0\nflags:\t02\nmnt_id:\t15\n');
    // File 2: inotify with 3 watches
    writeFileSync(
      join(fakeFdinfo, '3'),
      'pos:\t0\nflags:\t02\nmnt_id:\t15\ninotify wd:1 ino:1234 sdev:800001 mask:800afff ignored_mask:0 fhandle-bytes:8 fhandle-type:1 f_handle:01\ninotify wd:2 ino:5678 sdev:800001 mask:800afff ignored_mask:0 fhandle-bytes:8 fhandle-type:1 f_handle:02\ninotify wd:3 ino:9012 sdev:800001 mask:800afff ignored_mask:0 fhandle-bytes:8 fhandle-type:1 f_handle:03\n',
    );
    // File 3: inotify with 2 watches
    writeFileSync(
      join(fakeFdinfo, '4'),
      'pos:\t0\nflags:\t02\nmnt_id:\t15\ninotify wd:1 ino:9999 sdev:800001 mask:800afff ignored_mask:0 fhandle-bytes:8 fhandle-type:1 f_handle:04\ninotify wd:2 ino:8888 sdev:800001 mask:800afff ignored_mask:0 fhandle-bytes:8 fhandle-type:1 f_handle:05\n',
    );

    expect(p.countInotifyWatches(1234, fakeFdinfo)).toBe(5);
    expect(p.countInotifyWatches(1234, join(root, 'nonexistent_fdinfo'))).toBeUndefined();
  });
});

