import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
