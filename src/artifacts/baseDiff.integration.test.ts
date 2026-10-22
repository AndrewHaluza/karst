import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultGitRunner } from '../integrations/git.js';
import { listBaseChanges } from './baseDiff.js';

const sh = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
};
const put = (root: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

describe('listBaseChanges', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'karst-basediff-'));
    sh(repo, 'init', '-q', '--initial-branch=develop');
    put(repo, 'docs/plans/old.md', 'old plan');
    put(repo, 'docs/plans/edit.md', 'v1');
    put(repo, 'docs/plans/gone.md', 'bye');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    sh(repo, 'checkout', '-q', '-b', 'ticket');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('lists added, modified, deleted and untracked — never unchanged base files', async () => {
    put(repo, 'docs/plans/edit.md', 'v2');
    rmSync(join(repo, 'docs/plans/gone.md'));
    put(repo, 'docs/plans/new.md', 'new');
    const out = await listBaseChanges(defaultGitRunner, repo, 'develop', () => {});
    const byPath = Object.fromEntries(out.map((c) => [c.relPath, c.kind]));
    expect(byPath).toEqual({
      'docs/plans/edit.md': 'modified',
      'docs/plans/gone.md': 'deleted',
      'docs/plans/new.md': 'added',
    });
  });

  it('includes committed-on-branch changes', async () => {
    put(repo, 'docs/plans/c.md', 'c');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'work');
    const out = await listBaseChanges(defaultGitRunner, repo, 'develop', () => {});
    expect(out).toEqual([{ relPath: 'docs/plans/c.md', kind: 'added' }]);
  });

  it('fails closed on an unresolvable base', async () => {
    const msgs: string[] = [];
    const out = await listBaseChanges(defaultGitRunner, repo, 'nope', (m) => msgs.push(m));
    expect(out).toEqual([]);
    expect(msgs.some((m) => m.includes('capturing nothing'))).toBe(true);
  });

  describe('stale local base', () => {
    const originOf = (): string => {
      // origin/develop = a bare clone's ref, advanced past local develop
      const bare = mkdtempSync(join(tmpdir(), 'karst-basediff-origin-'));
      sh(repo, 'clone', '-q', '--bare', repo, bare);
      sh(repo, 'remote', 'add', 'origin', bare);
      return bare;
    };

    it('does not list files landed on origin/base that the branch was cut from', async () => {
      const bare = originOf();
      try {
        sh(repo, 'checkout', '-q', 'develop');
        put(repo, 'docs/plans/landed.md', 'landed');
        sh(repo, 'add', '-A');
        sh(repo, 'commit', '-q', '-m', 'landed');
        sh(repo, 'push', '-q', 'origin', 'develop');
        sh(repo, 'checkout', '-q', 'ticket');
        sh(repo, 'merge', '-q', '--no-edit', 'develop');
        sh(repo, 'checkout', '-q', 'develop');
        sh(repo, 'reset', '-q', '--hard', 'HEAD~1'); // local develop is stale
        sh(repo, 'checkout', '-q', 'ticket');
        sh(repo, 'update-ref', 'refs/remotes/origin/develop', 'ticket');
        put(repo, 'docs/plans/mine.md', 'mine');
        const out = await listBaseChanges(defaultGitRunner, repo, 'develop', () => {});
        expect(out).toEqual([{ relPath: 'docs/plans/mine.md', kind: 'added' }]);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('does not list files from origin/base merged after the branch was cut', async () => {
      const bare = originOf();
      try {
        sh(repo, 'checkout', '-q', 'develop');
        put(repo, 'docs/plans/later.md', 'later');
        sh(repo, 'add', '-A');
        sh(repo, 'commit', '-q', '-m', 'later');
        sh(repo, 'update-ref', 'refs/remotes/origin/develop', 'develop');
        sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
        sh(repo, 'checkout', '-q', 'ticket');
        sh(repo, 'merge', '-q', '--no-edit', 'origin/develop');
        const out = await listBaseChanges(defaultGitRunner, repo, 'develop', () => {});
        expect(out).toEqual([]);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('only local base: unchanged behavior', async () => {
      put(repo, 'docs/plans/n.md', 'n');
      const out = await listBaseChanges(defaultGitRunner, repo, 'develop', () => {});
      expect(out).toEqual([{ relPath: 'docs/plans/n.md', kind: 'added' }]);
    });

    it('only origin base resolves: uses it', async () => {
      sh(repo, 'update-ref', 'refs/remotes/origin/develop', 'develop');
      sh(repo, 'branch', '-q', '-m', 'develop', 'renamed');
      put(repo, 'docs/plans/n.md', 'n');
      const out = await listBaseChanges(defaultGitRunner, repo, 'develop', () => {});
      expect(out).toEqual([{ relPath: 'docs/plans/n.md', kind: 'added' }]);
    });
  });
});
