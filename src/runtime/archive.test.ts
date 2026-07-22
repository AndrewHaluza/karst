import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { makePortAllocator } from '../resolver/allocator.js';
import { defaultGitRunner } from '../integrations/git.js';
import { createWorktree } from './worktree.js';
import { archiveWorktree, restoreWorktree } from './archive.js';
import { listArchives } from '../store/worktreeArchives.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** True if `refName` resolves in `cwd` — unlike `git()`, does not throw on a missing ref. */
function refResolves(cwd: string, refName: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', refName], { cwd, encoding: 'utf8' });
  return r.status === 0;
}

function makeRepo(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-arch-'));
  writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(dir, 'keep.txt'), 'original\n');
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'test@karst.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('archive/restore worktree', () => {
  let store: Store;
  let repo: { path: string; cleanup: () => void };

  beforeEach(() => {
    store = openStore(':memory:');
    repo = makeRepo();
  });
  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  function spinWorktree() {
    const rec = createWorktree(store, {
      ticketId: 1,
      repoPath: repo.path,
      slug: 'K-9',
      baseRef: 'develop',
    });
    return rec;
  }

  it('archives uncommitted work into a ref, removes the folder, keeps the branch; restore brings everything back', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, [4000, 4100]);

    // Dirty the worktree: modify tracked, add untracked, delete tracked.
    writeFileSync(join(rec.path, 'index.js'), 'console.log(2);\n'); // modified
    writeFileSync(join(rec.path, 'new.txt'), 'brand new\n'); // untracked
    unlinkSync(join(rec.path, 'keep.txt')); // deletion

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });

    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('refs/karst/archive/K-9');
    expect(existsSync(rec.path)).toBe(false); // folder reclaimed
    // branch survives in the parent repo
    expect(git(repo.path, 'rev-parse', '--verify', '--quiet', 'refs/heads/karst/K-9').trim()).not.toBe('');
    expect(listArchives(store, 1)).toHaveLength(1);

    // Restore
    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 1, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(existsSync(rec.path)).toBe(true);
    expect(readFileSync(join(rec.path, 'index.js'), 'utf8')).toBe('console.log(2);\n');
    expect(readFileSync(join(rec.path, 'new.txt'), 'utf8')).toBe('brand new\n');
    expect(existsSync(join(rec.path, 'keep.txt'))).toBe(false);
    // changes come back UNSTAGED
    expect(git(rec.path, 'status', '--porcelain')).not.toBe('');
    // ref + row cleared
    expect(refResolves(repo.path, 'refs/karst/archive/K-9')).toBe(false);
    expect(listArchives(store, 1)).toHaveLength(0);
  });

  it('with no uncommitted changes, records an empty ref and restore recreates a clean worktree', async () => {
    const rec = spinWorktree();
    const alloc = makePortAllocator(store, [4000, 4100]);

    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: rec.path,
      branch: rec.branch,
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('archived');
    expect(res.archiveRef).toBe('');
    expect(existsSync(rec.path)).toBe(false);

    const rr = await restoreWorktree(defaultGitRunner, store, { ticketId: 1, path: rec.path });
    expect(rr.outcome).toBe('restored');
    expect(existsSync(rec.path)).toBe(true);
    expect(git(rec.path, 'status', '--porcelain')).toBe('');
  });

  it('skips an orphan folder (folder present but not a registered worktree)', async () => {
    const orphan = join(repo.path, 'not-a-worktree');
    mkdtempSync(join(tmpdir(), 'ignore-')); // noop to keep imports honest
    writeFileSync(join(repo.path, 'placeholder'), 'x'); // ensure repo writable
    const alloc = makePortAllocator(store, [4000, 4100]);
    // Create a bare folder that is not a git worktree.
    rmSync(orphan, { recursive: true, force: true });
    writeFileSync(join(repo.path, 'orphan-marker'), 'x');
    const res = await archiveWorktree(defaultGitRunner, store, alloc, {
      ticketId: 1,
      repoPath: repo.path,
      path: join(repo.path, 'orphan-marker-dir-does-not-exist'),
      branch: 'karst/none',
      baseRef: 'develop',
    });
    expect(res.outcome).toBe('skipped');
  });
});
