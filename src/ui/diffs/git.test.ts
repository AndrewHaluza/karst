import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { defaultGitRunner, GIT_TIMEOUT_MS, runGit, type GitRunner } from '../../integrations/git.js';
import {
  DIFF_CONTENT_MAX_BYTES,
  inspectWorktree,
  parseCommitHeaders,
  parseNameStatus,
  prepareDiff,
  TextDiffUnavailableError,
  type WorktreeSpec,
} from './git.js';

const TEST_GIT_OPTIONS = { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' } as const;

function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, ...TEST_GIT_OPTIONS });
}

function write(cwd: string, path: string, content: string): void {
  writeFileSync(join(cwd, path), content);
}

function commit(cwd: string, message: string): void {
  fixtureGit(cwd, ['add', '-A']);
  fixtureGit(cwd, ['commit', '-m', message]);
}

function createWorktreeFixture(): { dir: string; spec: WorktreeSpec; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-diff-'));
  fixtureGit(dir, ['init', '-q']);
  fixtureGit(dir, ['config', 'user.name', 'Karst Test']);
  fixtureGit(dir, ['config', 'user.email', 'karst-test@example.com']);

  write(dir, 'value.txt', 'value=1\n');
  write(dir, 'unstaged.txt', 'unstaged=1\n');
  write(dir, 'gone.ts', 'gone\n');
  write(dir, 'old name.ts', 'old\n');
  write(dir, 'clean file.ts', 'clean\n');
  commit(dir, 'base');
  const base = fixtureGit(dir, ['rev-parse', 'HEAD']).trim();

  write(dir, 'commit only.ts', 'alpha\n');
  commit(dir, 'add a commit file');

  fixtureGit(dir, ['mv', 'old name.ts', 'new name.ts']);
  fixtureGit(dir, ['rm', 'gone.ts']);
  write(dir, 'new file.ts', 'new\n');
  commit(dir, 'rename and remove files');

  write(dir, 'value.txt', 'value=2\n');
  fixtureGit(dir, ['add', 'value.txt']);
  write(dir, 'value.txt', 'value=3\n');
  write(dir, 'staged only.txt', 'staged\n');
  fixtureGit(dir, ['add', 'staged only.txt']);
  write(dir, 'unstaged.txt', 'unstaged=2\n');
  write(dir, 'untracked file.txt', 'untracked\n');

  return {
    dir,
    base,
    spec: { label: 'Repository', path: dir, branch: 'feature/diff', baseRef: base },
  };
}

const workingFile = {
  stat: async (path: string) => ({ size: statSync(path).size }),
  read: async (path: string) => readFileSync(path),
};

const diffContentGit: GitRunner = (args, cwd) =>
  runGit(args, cwd, GIT_TIMEOUT_MS, DIFF_CONTENT_MAX_BYTES);

describe('parseNameStatus', () => {
  it('parses NUL-delimited adds, deletes, and renames without splitting spaces', () => {
    expect(parseNameStatus('A\0new file.ts\0D\0gone.ts\0R100\0old name.ts\0new name.ts\0')).toEqual([
      { status: 'added', path: 'new file.ts', oldPath: null },
      { status: 'deleted', path: 'gone.ts', oldPath: null },
      { status: 'renamed', path: 'new name.ts', oldPath: 'old name.ts' },
    ]);
  });

  it('rejects incomplete records instead of returning a partial file list', () => {
    expect(() => parseNameStatus('A\0')).toThrow(/incomplete/i);
  });
});

describe('parseCommitHeaders', () => {
  it('parses hand-written NUL-delimited commit fields', () => {
    expect(
      parseCommitHeaders(
        '1234567890abcdef\0' +
          '1234567\0' +
          'Ada Lovelace\0' +
          '2026-07-30T12:34:56+00:00\0' +
          'Add a file with spaces\0',
      ),
    ).toEqual([
      {
        hash: '1234567890abcdef',
        shortHash: '1234567',
        author: 'Ada Lovelace',
        authoredAt: '2026-07-30T12:34:56+00:00',
        subject: 'Add a file with spaces',
      },
    ]);
  });

  it('rejects incomplete commit fields instead of returning a partial commit list', () => {
    expect(() => parseCommitHeaders('123\0abc\0Ada\0')).toThrow(/incomplete/i);
  });
});

describe('inspectWorktree', () => {
  it('lists first-parent commits since base newest-first with exact commit files', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const inspected = await inspectWorktree(defaultGitRunner, spec);

      expect(inspected.commits.map((commit) => commit.subject)).toEqual([
        'rename and remove files',
        'add a commit file',
      ]);
      expect(inspected.commits[0]!.files.map((file) => ({
        status: file.status,
        path: file.path,
        oldPath: file.oldPath,
      }))).toEqual([
        { status: 'deleted', path: 'gone.ts', oldPath: null },
        { status: 'added', path: 'new file.ts', oldPath: null },
        { status: 'renamed', path: 'new name.ts', oldPath: 'old name.ts' },
      ]);
      expect(inspected.commits[1]!.files.map((file) => file.path)).toEqual(['commit only.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates staged, unstaged, staged-plus-unstaged, and untracked paths', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const inspected = await inspectWorktree(defaultGitRunner, spec);
      const stagedValue = inspected.staged.find((file) => file.path === 'value.txt')!;
      const unstagedValue = inspected.unstaged.find((file) => file.path === 'value.txt')!;

      expect(inspected.staged.map((file) => file.path)).toEqual(['staged only.txt', 'value.txt']);
      expect(inspected.unstaged.map((file) => file.path)).toEqual(['unstaged.txt', 'value.txt']);
      expect(inspected.untracked.map((file) => file.path)).toEqual(['untracked file.txt']);
      expect(stagedValue.target.left).toMatchObject({ kind: 'git', revision: 'HEAD', path: 'value.txt' });
      expect(stagedValue.target.right).toMatchObject({ kind: 'index', path: 'value.txt' });
      expect(unstagedValue.target.left).toMatchObject({ kind: 'index', path: 'value.txt' });
      expect(unstagedValue.target.right).toMatchObject({ kind: 'working', path: join(dir, 'value.txt') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps clean worktrees and paths containing spaces', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const inspected = await inspectWorktree(defaultGitRunner, spec);
      expect(inspected.commits[0]!.files).toContainEqual(
        expect.objectContaining({ path: 'new name.ts', oldPath: 'old name.ts' }),
      );

      const cleanSpec = { ...spec, baseRef: fixtureGit(dir, ['rev-parse', 'HEAD']).trim() };
      fixtureGit(dir, ['reset', '--hard', '-q']);
      fixtureGit(dir, ['clean', '-fdq']);
      await expect(inspectWorktree(defaultGitRunner, cleanSpec)).resolves.toMatchObject({
        commits: [],
        staged: [],
        unstaged: [],
        untracked: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves added, deleted, and renamed old/new paths', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const files = (await inspectWorktree(defaultGitRunner, spec)).commits[0]!.files;
      expect(files).toContainEqual(expect.objectContaining({ status: 'added', path: 'new file.ts', oldPath: null }));
      expect(files).toContainEqual(expect.objectContaining({ status: 'deleted', path: 'gone.ts', oldPath: null }));
      expect(files).toContainEqual(
        expect.objectContaining({ status: 'renamed', path: 'new name.ts', oldPath: 'old name.ts' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid recorded base instead of guessing', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      await expect(inspectWorktree(defaultGitRunner, { ...spec, baseRef: 'missing-base' })).rejects.toThrow(
        /Repository/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepareDiff', () => {
  it('reads Git-backed text between 1 MiB and 5 MiB through the content runner', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const content = 'x'.repeat(1024 * 1024 + 1);
      write(dir, 'large staged.txt', content);
      fixtureGit(dir, ['add', 'large staged.txt']);
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === 'large staged.txt',
      )!.target;

      const prepared = await prepareDiff(diffContentGit, target, workingFile);

      expect(prepared.right).toMatchObject({ kind: 'virtual', content });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares literal staged and unstaged content while leaving working content live', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const inspected = await inspectWorktree(defaultGitRunner, spec);
      const stagedTarget = inspected.staged.find((file) => file.path === 'value.txt')!.target;
      const unstagedTarget = inspected.unstaged.find((file) => file.path === 'value.txt')!.target;

      const staged = await prepareDiff(defaultGitRunner, stagedTarget, workingFile);
      const unstaged = await prepareDiff(defaultGitRunner, unstagedTarget, workingFile);

      expect(staged.left).toMatchObject({ kind: 'virtual', content: 'value=1\n' });
      expect(staged.right).toMatchObject({ kind: 'virtual', content: 'value=2\n' });
      expect(unstaged.left).toMatchObject({ kind: 'virtual', content: 'value=2\n' });
      expect(unstaged.right).toMatchObject({ kind: 'file', path: join(dir, 'value.txt') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares empty added and deleted sides and labels both rename paths', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const commitFiles = (await inspectWorktree(defaultGitRunner, spec)).commits[0]!.files;
      const added = await prepareDiff(
        defaultGitRunner,
        commitFiles.find((file) => file.status === 'added')!.target,
        workingFile,
      );
      const deleted = await prepareDiff(
        defaultGitRunner,
        commitFiles.find((file) => file.status === 'deleted')!.target,
        workingFile,
      );
      const renamed = await prepareDiff(
        defaultGitRunner,
        commitFiles.find((file) => file.status === 'renamed')!.target,
        workingFile,
      );

      expect(added.left).toMatchObject({ kind: 'virtual', content: '' });
      expect(deleted.right).toMatchObject({ kind: 'virtual', content: '' });
      expect(renamed.left.label).toContain('old name.ts');
      expect(renamed.right.label).toContain('new name.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses binary untracked files', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      writeFileSync(join(dir, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'binary.bin',
      )!.target;
      await expect(prepareDiff(defaultGitRunner, target, workingFile)).rejects.toBeInstanceOf(
        TextDiffUnavailableError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses text resources larger than 5 MiB', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      write(dir, 'large.txt', 'x'.repeat(DIFF_CONTENT_MAX_BYTES + 1));
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'large.txt',
      )!.target;
      await expect(prepareDiff(defaultGitRunner, target, workingFile)).rejects.toBeInstanceOf(
        TextDiffUnavailableError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
