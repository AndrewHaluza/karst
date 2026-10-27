import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeReadinessProbes } from './nodeProbes.js';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

let root: string;
let repo: string;
let remote: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'setup-check-'));
  repo = join(root, 'repo');
  remote = join(root, 'remote.git');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(root, 'init', '-q', '--bare', remote);
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', '-q', 'origin', 'main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('nodeReadinessProbes', () => {
  const p = nodeReadinessProbes();
  it('isGitRepo', () => {
    expect(p.isGitRepo(repo)).toBe(true);
    expect(p.isGitRepo(root)).toBe(false);
  });
  it('branchExists and hasRemote', () => {
    expect(p.branchExists(repo, 'main')).toBe(true);
    expect(p.branchExists(repo, 'nope')).toBe(false);
    expect(p.hasRemote(repo, 'origin')).toBe(true);
    expect(p.hasRemote(repo, 'upstream')).toBe(false);
  });
  it('remoteReachable', async () => {
    expect(await p.remoteReachable(repo)).toBe(true);
    sh(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    expect(await p.remoteReachable(repo)).toBe(false);
  });
  it('worktreeTrial creates and removes', async () => {
    expect(await p.worktreeTrial(repo, 'main')).toEqual({ ok: true });
    const dir = join(repo, '.karst', 'worktrees');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(sh(repo, 'worktree', 'list').toString().trim().split('\n')).toHaveLength(1);
  });
  it('worktreeTrial fails for a missing branch', async () => {
    const t = await p.worktreeTrial(repo, 'nope');
    expect(t.ok).toBe(false);
    expect(t.error).toContain('nope');
  });
  it('worktreeTrial falls back to origin/<branch>', async () => {
    sh(repo, 'checkout', '-q', '-b', 'other');
    sh(repo, 'branch', '-q', '-D', 'main');
    expect(await p.worktreeTrial(repo, 'main')).toEqual({ ok: true });
  });
  it('baseDefinesScript reads package.json on the baseline', async () => {
    expect(await p.baseDefinesScript(repo, 'main', 'test')).toBe(true);
    expect(await p.baseDefinesScript(repo, 'main', 'lint')).toBe(false);
    expect(await p.baseDefinesScript(repo, 'nope', 'test')).toBe(false);
  });
  it('fileExists and binaryResolves', () => {
    expect(p.fileExists(repo, 'package.json')).toBe(true);
    expect(p.binaryResolves('git')).toBe(true);
    expect(p.binaryResolves('definitely-not-a-binary-xyz')).toBe(false);
  });
  it('relative repoPath resolves against baseDir', () => {
    expect(nodeReadinessProbes(root).isGitRepo('repo')).toBe(true);
  });
});
