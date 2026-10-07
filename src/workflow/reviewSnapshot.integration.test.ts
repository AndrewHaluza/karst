import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitRunner, runGit, type GitRunner } from '../integrations/git.js';
import {
  createReviewSnapshot,
  deleteReviewSnapshot,
  snapshotRefName,
} from './reviewSnapshot.js';

async function freshRepo(tag: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `karst-snapshot-${tag}-`));
  const init = await runGit(['init', '-b', 'main'], dir);
  expect(init.exitCode).toBe(0);
  await runGit(['config', 'user.name', 'Test'], dir);
  await runGit(['config', 'user.email', 'test@example.com'], dir);
  await runGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

async function writeAndCommit(dir: string, file: string, content: string, msg: string): Promise<void> {
  writeFileSync(join(dir, file), content);
  const add = await runGit(['add', '-A'], dir);
  expect(add.exitCode).toBe(0);
  const commit = await runGit(['commit', '-m', msg], dir);
  expect(commit.exitCode).toBe(0);
}

describe('reviewSnapshot', () => {
  it('captures uncommitted tracked, staged and untracked files in the snapshot tree', async () => {
    const dir = await freshRepo('captures');
    try {
      await writeAndCommit(dir, 'tracked.txt', 'base', 'base');
      const head = (await runGit(['rev-parse', 'HEAD'], dir)).stdout.trim();

      writeFileSync(join(dir, 'tracked.txt'), 'changed');
      writeFileSync(join(dir, 'staged.txt'), 'staged');
      const add = await runGit(['add', 'staged.txt'], dir);
      expect(add.exitCode).toBe(0);
      writeFileSync(join(dir, 'untracked.txt'), 'untracked');

      const ref = await createReviewSnapshot(defaultGitRunner, {
        ticketId: 42,
        repoPath: dir,
        worktreePath: dir,
      });

      expect(ref).toBe(snapshotRefName(42, dir));
      const diff = await runGit(['diff', '--name-only', `${head}...${ref}`], dir);
      expect(diff.stdout.trim().split('\n').filter(Boolean).sort()).toEqual([
        'staged.txt',
        'tracked.txt',
        'untracked.txt',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves HEAD, the branch and the index untouched', async () => {
    const dir = await freshRepo('untouched');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      writeFileSync(join(dir, 'a.txt'), 'b');
      const beforeHead = (await runGit(['rev-parse', 'HEAD'], dir)).stdout;
      const beforeBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout;
      const beforeStatus = (await runGit(['status', '--porcelain'], dir)).stdout;

      const ref = await createReviewSnapshot(defaultGitRunner, {
        ticketId: 43,
        repoPath: dir,
        worktreePath: dir,
      });
      expect(ref).toBe(snapshotRefName(43, dir));

      expect((await runGit(['rev-parse', 'HEAD'], dir)).stdout).toBe(beforeHead);
      expect((await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout).toBe(beforeBranch);
      expect((await runGit(['status', '--porcelain'], dir)).stdout).toBe(beforeStatus);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the snapshot ref is reachable and its parent is the pre-call HEAD', async () => {
    const dir = await freshRepo('reachable');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const head = (await runGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
      const ref = await createReviewSnapshot(defaultGitRunner, {
        ticketId: 44,
        repoPath: dir,
        worktreePath: dir,
      });
      expect(ref).toBe(snapshotRefName(44, dir));
      expect((await runGit(['rev-parse', `${ref}^`], dir)).stdout.trim()).toBe(head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors .gitignore', async () => {
    const dir = await freshRepo('ignore');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
      writeFileSync(join(dir, 'ignored.txt'), 'ignored');
      const ref = await createReviewSnapshot(defaultGitRunner, {
        ticketId: 45,
        repoPath: dir,
        worktreePath: dir,
      });
      const diff = await runGit(['diff', '--name-only', `${await runGit(['rev-parse', 'HEAD'], dir).then((r) => r.stdout.trim())}...${ref}`], dir);
      expect(diff.stdout).not.toContain('ignored.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a clean worktree still produces a ref whose tree equals HEAD\'s tree', async () => {
    const dir = await freshRepo('clean');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const head = (await runGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
      const ref = await createReviewSnapshot(defaultGitRunner, {
        ticketId: 46,
        repoPath: dir,
        worktreePath: dir,
      });
      expect((await runGit(['rev-parse', `${ref}^{tree}`], dir)).stdout.trim()).toBe(
        (await runGit(['rev-parse', 'HEAD^{tree}'], dir)).stdout.trim(),
      );
      expect((await runGit(['rev-parse', `${ref}^`], dir)).stdout.trim()).toBe(head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null and never throws when HEAD is unborn', async () => {
    const dir = await freshRepo('unborn');
    try {
      await expect(
        createReviewSnapshot(defaultGitRunner, {
          ticketId: 47,
          repoPath: dir,
          worktreePath: dir,
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when update-ref fails', async () => {
    const dir = await freshRepo('update-ref');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const git: GitRunner = async (args, cwd) => {
        if (args[0] === 'update-ref') return { stdout: '', stderr: 'boom', exitCode: 1 };
        return defaultGitRunner(args, cwd);
      };
      await expect(
        createReviewSnapshot(git, {
          ticketId: 48,
          repoPath: dir,
          worktreePath: dir,
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteReviewSnapshot removes the ref and is safe to call twice', async () => {
    const dir = await freshRepo('delete');
    try {
      await writeAndCommit(dir, 'a.txt', 'a', 'base');
      const ref = (await createReviewSnapshot(defaultGitRunner, {
        ticketId: 49,
        repoPath: dir,
        worktreePath: dir,
      }))!;
      await deleteReviewSnapshot(defaultGitRunner, {
        ticketId: 49,
        repoPath: dir,
        worktreePath: dir,
      });
      expect((await runGit(['rev-parse', '--verify', ref], dir)).exitCode).not.toBe(0);
      await expect(
        deleteReviewSnapshot(defaultGitRunner, {
          ticketId: 49,
          repoPath: dir,
          worktreePath: dir,
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snapshotRefName is stable and ref-safe', async () => {
    const a = snapshotRefName(50, '/tmp/repo-a');
    const b = snapshotRefName(50, '/tmp/repo-b');
    expect(a).toMatch(/^refs\/karst\/snapshot\/\d+\/[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
