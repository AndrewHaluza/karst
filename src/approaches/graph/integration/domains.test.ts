/**
 * Physical-domain resolution tests (Slice 3 Task 8).
 *
 * The integration domain is keyed by canonical worktree realpath PLUS Git
 * common-directory identity — never the manifest repository name, because
 * multiple repository entries may intentionally share one `repoPath`. Two
 * entries sharing a worktree resolve to ONE domain whose change sets
 * serialize; deterministic ordering is by domain key.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolvePhysicalDomains,
  domainKeyOf,
  gitCommonDirFromFs,
  resolveRepoWorktrees,
} from './domains.js';
import { canonicalPath } from '../../../runtime/pathScope.js';

describe('domainKeyOf', () => {
  it('combines the canonical worktree and the git common dir into one key', () => {
    const a = domainKeyOf('/wt/t1', '/wt/.git');
    const b = domainKeyOf('/wt/t1', '/wt/.git');
    const c = domainKeyOf('/wt/t1', '/other/.git');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('resolvePhysicalDomains', () => {
  const gitCommonDirOf = (cwd: string): string | null =>
    cwd.includes('real') ? join(cwd, '.git') : null;

  it('resolves distinct worktrees to distinct domains, sorted by key', () => {
    const domains = resolvePhysicalDomains(
      [
        { repoName: 'b', worktreePath: '/wt/b' },
        { repoName: 'a', worktreePath: '/wt/a' },
      ],
      gitCommonDirOf,
    );
    expect(domains.map((d) => d.repoNames[0]!)).toEqual(['a', 'b']);
    expect(domains[0]!.key).not.toBe(domains[1]!.key);
  });

  it('two repository entries sharing one repoPath resolve to ONE domain and serialize', () => {
    const domains = resolvePhysicalDomains(
      [
        { repoName: 'api', worktreePath: '/wt/shared' },
        { repoName: 'web', worktreePath: '/wt/shared' },
      ],
      gitCommonDirOf,
    );
    expect(domains).toHaveLength(1);
    expect(domains[0]!.repoNames).toEqual(['api', 'web']);
  });

  it('uses the canonical realpath so symlinked worktrees alias the same domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-domain-'));
    try {
      const real = join(dir, 'real');
      const link = join(dir, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      const domains = resolvePhysicalDomains(
        [
          { repoName: 'a', worktreePath: real },
          { repoName: 'b', worktreePath: link },
        ],
        gitCommonDirOf,
      );
      expect(domains).toHaveLength(1);
      expect(domains[0]!.repoNames).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps entries whose git common dir is unknown (probe failure) in a domain', () => {
    const domains = resolvePhysicalDomains(
      [{ repoName: 'a', worktreePath: '/wt/a' }],
      gitCommonDirOf,
    );
    expect(domains).toHaveLength(1);
    expect(domains[0]!.gitCommonDir).toBeNull();
  });
});

describe('resolveRepoWorktrees', () => {
  const repos = {
    extention: { repoPath: '/repo/karst' },
    api: { repoPath: '/repo/api' },
    web: { repoPath: '/repo/mono' },
    docs: { repoPath: '/repo/mono' },
  };
  const worktrees = [
    { repo: '/repo/karst', path: '/repo/karst/.karst/worktrees/T-1' },
    { repo: '/repo/api', path: '/repo/api/.karst/worktrees/T-1' },
    { repo: '/repo/mono', path: '/repo/mono/.karst/worktrees/T-1' },
  ];

  it('resolves each manifest repo NAME through its repoPath to the worktree path', () => {
    const entries = resolveRepoWorktrees(repos, worktrees);
    expect(entries).toEqual([
      { repoName: 'extention', worktreePath: '/repo/karst/.karst/worktrees/T-1' },
      { repoName: 'api', worktreePath: '/repo/api/.karst/worktrees/T-1' },
      { repoName: 'web', worktreePath: '/repo/mono/.karst/worktrees/T-1' },
      { repoName: 'docs', worktreePath: '/repo/mono/.karst/worktrees/T-1' },
    ]);
  });

  it('a monorepo: two manifest entries sharing one repoPath resolve to the ONE worktree', () => {
    const entries = resolveRepoWorktrees(repos, worktrees);
    expect(entries.filter((e) => e.repoName === 'web' || e.repoName === 'docs')).toEqual([
      { repoName: 'web', worktreePath: '/repo/mono/.karst/worktrees/T-1' },
      { repoName: 'docs', worktreePath: '/repo/mono/.karst/worktrees/T-1' },
    ]);
  });

  it('omits manifest entries whose repository has no worktree registered for the ticket', () => {
    const entries = resolveRepoWorktrees({ ghost: { repoPath: '/repo/ghost' } }, worktrees);
    expect(entries).toEqual([]);
  });

  it('an empty worktree list resolves to no entries', () => {
    expect(resolveRepoWorktrees(repos, [])).toEqual([]);
  });
});

describe('gitCommonDirFromFs', () => {
  it('a directory .git is its own common dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-domain-'));
    try {
      mkdirSync(join(dir, '.git'));
      expect(gitCommonDirFromFs(dir)).toBe(canonicalPath(join(dir, '.git')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a linked worktree .git file resolves the common dir before /worktrees/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-domain-'));
    try {
      const common = join(dir, 'repo', '.git');
      mkdirSync(common, { recursive: true });
      const wt = join(dir, 'wt');
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, '.git'), `gitdir: ${join(common, 'worktrees', 't-1')}\n`);
      expect(gitCommonDirFromFs(wt)).toBe(canonicalPath(common));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing .git declines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-domain-'));
    try {
      expect(gitCommonDirFromFs(join(dir, 'nope'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
