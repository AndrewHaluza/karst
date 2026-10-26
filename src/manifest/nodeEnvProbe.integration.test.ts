import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeEnvProbe } from './nodeEnvProbe.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore' });

describe('nodeEnvProbe', () => {
  let root: string;
  let repo: string;
  let linked: string;
  const probe = nodeEnvProbe();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-envprobe-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'scripts', 'verify-uat.sh'), '');
    linked = join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feat');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds a local branch and misses develop in a repo that only has main', () => {
    expect(probe.branchExists(repo, 'main')).toBe(true);
    expect(probe.branchExists(repo, 'develop')).toBe(false);
  });

  it('finds a packed or remote-tracking ref', () => {
    git(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    expect(probe.branchExists(repo, 'develop')).toBe(true);
    git(repo, 'pack-refs', '--all');
    expect(probe.branchExists(repo, 'develop')).toBe(true);
  });

  it('reads refs through a linked worktree', () => {
    expect(probe.branchExists(linked, 'main')).toBe(true);
  });

  it('reports a missing origin, then finds it once added', () => {
    expect(probe.hasRemote(repo, 'origin')).toBe(false);
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/r.git');
    expect(probe.hasRemote(repo, 'origin')).toBe(true);
    expect(probe.hasRemote(linked, 'origin')).toBe(true);
  });

  it('treats a non-repo as having no branch or remote', () => {
    expect(probe.branchExists(root, 'main')).toBe(false);
    expect(probe.hasRemote(root, 'origin')).toBe(false);
  });

  it('checks repo-relative files', () => {
    expect(probe.fileExists(repo, 'scripts/verify-uat.sh')).toBe(true);
    expect(probe.fileExists(repo, 'scripts/nope.sh')).toBe(false);
  });
});
