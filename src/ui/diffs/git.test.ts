import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  defaultGitRunner,
  GIT_TERMINATION_GRACE_MS,
  GIT_TIMEOUT_MS,
  runGitBytes,
  type GitBytesRunner,
  type GitRunner,
} from '../../integrations/git.js';
import {
  DIFF_CONTENT_MAX_BYTES,
  inspectWorktree,
  parseCommitHeaders,
  parseStageZeroEntries,
  parseNameStatus,
  prepareDiff,
  StaleDiffTargetError,
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
  lstat: async (path: string) => {
    const entry = lstatSync(path);
    return {
      dev: entry.dev,
      ino: entry.ino,
      mode: entry.mode,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      isSymbolicLink: () => entry.isSymbolicLink(),
    };
  },
  realpath: async (path: string) => realpathSync(path),
  readlink: async (path: string) => readlinkSync(path),
  read: async (path: string) => readFileSync(path),
};

const diffContentGit: GitBytesRunner = (args, cwd, options) =>
  runGitBytes(
    args,
    cwd,
    GIT_TIMEOUT_MS,
    DIFF_CONTENT_MAX_BYTES,
    GIT_TERMINATION_GRACE_MS,
    options?.signal,
  );

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

  it('accepts an empty commit subject while requiring every preceding field', () => {
    expect(
      parseCommitHeaders(
        '1234567890abcdef\0' +
          '1234567\0' +
          'Ada Lovelace\0' +
          '2026-07-30T12:34:56+00:00\0' +
          '\0',
      ),
    ).toEqual([
      {
        hash: '1234567890abcdef',
        shortHash: '1234567',
        author: 'Ada Lovelace',
        authoredAt: '2026-07-30T12:34:56+00:00',
        subject: '',
      },
    ]);
  });
});

describe('parseStageZeroEntries', () => {
  it('parses the metadata prefix without interpreting numeric-colon filenames', () => {
    expect(
      parseStageZeroEntries(
        '100644 1111111111111111111111111111111111111111 0\t0:secret\0' +
          '100755 2222222222222222222222222222222222222222 0\t2:script\0' +
          '100644 3333333333333333333333333333333333333333 2\tconflict\0',
      ),
    ).toEqual(new Map([
      ['0:secret', '1111111111111111111111111111111111111111'],
      ['2:script', '2222222222222222222222222222222222222222'],
    ]));
  });
});

describe('inspectWorktree', () => {
  it('inspects a real Git commit with an empty subject', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      write(dir, 'empty subject.ts', 'empty subject\n');
      fixtureGit(dir, ['add', 'empty subject.ts']);
      fixtureGit(dir, ['commit', '--allow-empty-message', '-m', '']);

      const inspected = await inspectWorktree(defaultGitRunner, spec);
      const emptySubjectCommit = inspected.commits[0]!;

      expect(emptySubjectCommit.subject).toBe('');
      expect(emptySubjectCommit.files).toContainEqual(
        expect.objectContaining({ path: 'empty subject.ts', status: 'added' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('lists a real merge commit and compares it with its first parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-diff-merge-'));
    try {
      fixtureGit(dir, ['init', '-q']);
      fixtureGit(dir, ['config', 'user.name', 'Karst Test']);
      fixtureGit(dir, ['config', 'user.email', 'karst-test@example.com']);
      write(dir, 'base.txt', 'base\n');
      commit(dir, 'base');
      const base = fixtureGit(dir, ['rev-parse', 'HEAD']).trim();

      fixtureGit(dir, ['checkout', '-q', '-b', 'side']);
      write(dir, 'from-side.txt', 'side\n');
      commit(dir, 'side only');
      fixtureGit(dir, ['checkout', '-q', '-b', 'ticket', base]);
      write(dir, 'from-ticket.txt', 'ticket\n');
      commit(dir, 'ticket only');
      const firstParent = fixtureGit(dir, ['rev-parse', 'HEAD']).trim();
      fixtureGit(dir, ['merge', '--no-ff', 'side', '-m', 'merge side']);

      const inspected = await inspectWorktree(defaultGitRunner, {
        label: 'Merge Repository',
        path: dir,
        branch: 'ticket',
        baseRef: base,
      });

      expect(inspected.commits.map((entry) => entry.subject)).toEqual([
        'merge side',
        'ticket only',
      ]);
      expect(inspected.commits[0]!.files).toContainEqual(
        expect.objectContaining({
          status: 'added',
          path: 'from-side.txt',
          target: expect.objectContaining({
            left: { kind: 'empty', label: firstParent },
          }),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the captured HEAD OID even if HEAD advances before later inspection commands', async () => {
    const { dir, spec, base } = createWorktreeFixture();
    try {
      fixtureGit(dir, ['reset', '--hard', '-q']);
      fixtureGit(dir, ['clean', '-fdq']);
      const capturedHead = fixtureGit(dir, ['rev-parse', 'HEAD']).trim();
      const seen: string[][] = [];
      let advanced = false;
      const advancingGit: GitRunner = async (args, cwd, options) => {
        seen.push(args);
        if (args[0] === 'log' && !advanced) {
          advanced = true;
          write(dir, 'later.ts', 'later\n');
          commit(dir, 'later commit');
        }
        return defaultGitRunner(args, cwd, options);
      };

      const inspected = await inspectWorktree(advancingGit, { ...spec, baseRef: base });

      expect(inspected.commits.map((entry) => entry.subject)).toEqual([
        'rename and remove files',
        'add a commit file',
      ]);
      expect(seen.find((args) => args[0] === 'log')).toContain(`${base}..${capturedHead}`);
      expect(seen.find((args) => args[0] === 'diff' && args.includes('--cached'))).toContain(
        capturedHead,
      );
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
      expect(stagedValue.target.left).toMatchObject({
        kind: 'git',
        revision: fixtureGit(dir, ['rev-parse', 'HEAD']).trim(),
        path: 'value.txt',
      });
      expect(stagedValue.target.right).toMatchObject({
        kind: 'index',
        blob: fixtureGit(dir, ['rev-parse', ':./value.txt']).trim(),
        path: 'value.txt',
      });
      expect(unstagedValue.target.left).toMatchObject({
        kind: 'index',
        blob: fixtureGit(dir, ['rev-parse', ':./value.txt']).trim(),
        path: 'value.txt',
      });
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

  it('keeps legitimate worktree paths whose first component starts with two dots', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      mkdirSync(join(dir, '..notes'));
      write(dir, '..notes/file.txt', 'notes\n');

      const inspected = await inspectWorktree(defaultGitRunner, spec);

      expect(inspected.untracked).toContainEqual(
        expect.objectContaining({ path: '..notes/file.txt', status: 'added' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a Git-reported path that traverses outside the worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-diff-containment-'));
    const hostileGit: GitRunner = async (args) => {
      const command = args[0];
      const stdout =
        command === 'rev-parse'
          ? args[2] === 'HEAD^{commit}'
            ? 'head\n'
            : 'base\n'
          : command === 'merge-base'
            ? 'base\n'
          : command === 'ls-files' && !args.includes('--stage')
              ? '../escape.txt\0'
              : '';
      return { stdout, stderr: '', exitCode: 0 };
    };

    try {
      await expect(
        inspectWorktree(hostileGit, {
          label: 'Hostile Repository',
          path: dir,
          branch: 'feature/diff',
          baseRef: 'base',
        }),
      ).rejects.toThrow(/out-of-worktree path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepareDiff', () => {
  it('opens the captured stage-zero blob for a numeric-colon filename', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      write(dir, '0:secret', 'captured stage zero\n');
      fixtureGit(dir, ['add', '0:secret']);
      const expectedBlob = fixtureGit(dir, ['rev-parse', ':./0:secret']).trim();
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === '0:secret',
      )!.target;

      expect(target.right).toMatchObject({ kind: 'index', path: '0:secret', blob: expectedBlob });
      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).resolves.toMatchObject({
        right: { kind: 'virtual', content: 'captured stage zero\n' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads Git-backed text between 1 MiB and 5 MiB through the content runner', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const content = 'x'.repeat(1024 * 1024 + 1);
      write(dir, 'large staged.txt', content);
      fixtureGit(dir, ['add', 'large staged.txt']);
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === 'large staged.txt',
      )!.target;

      const prepared = await prepareDiff(defaultGitRunner, target, workingFile, diffContentGit);

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
      expect(unstaged.right).toMatchObject({
        kind: 'file',
        path: realpathSync(join(dir, 'value.txt')),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares display-only titles and stable resources for the native diff adapter', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const inspected = await inspectWorktree(defaultGitRunner, spec);
      const stagedTarget = inspected.staged.find((file) => file.path === 'value.txt')!.target;
      const unstagedTarget = inspected.unstaged.find((file) => file.path === 'value.txt')!.target;

      const staged = await prepareDiff(defaultGitRunner, stagedTarget, workingFile);
      const unstaged = await prepareDiff(defaultGitRunner, unstagedTarget, workingFile);

      expect(staged).toEqual({
        title: 'Repository · Staged Changes · value.txt',
        left: { kind: 'virtual', label: 'value.txt (HEAD)', content: 'value=1\n' },
        right: { kind: 'virtual', label: 'value.txt (index)', content: 'value=2\n' },
      });
      expect(unstaged.left).toEqual({
        kind: 'virtual',
        label: 'value.txt (index)',
        content: 'value=2\n',
      });
      expect(unstaged.right).toEqual({
        kind: 'file',
        label: 'value.txt (working tree)',
        path: realpathSync(
          (unstagedTarget.right as { kind: 'working'; path: string }).path,
        ),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a working resource that cannot be read after it is inspected', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).unstaged.find(
        (file) => file.path === 'value.txt',
      )!.target;
      const unreadableWorkingFile = {
        ...workingFile,
        read: async (_path: string): Promise<Buffer> => {
          throw new Error('EACCES: file became unreadable');
        },
      };

      await expect(
        prepareDiff(defaultGitRunner, target, unreadableWorkingFile),
      ).rejects.toBeInstanceOf(TextDiffUnavailableError);
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

      expect(added.left).toEqual({
        kind: 'virtual',
        label: 'new file.ts (empty)',
        content: '',
      });
      expect(deleted.right).toEqual({
        kind: 'virtual',
        label: 'gone.ts (empty)',
        content: '',
      });
      expect(renamed.left.label).toMatch(/^old name\.ts \([0-9a-f]{7}\)$/);
      expect(renamed.right.label).toMatch(/^new name\.ts \([0-9a-f]{7}\)$/);
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

  it('refuses invalid UTF-8 from a Git-backed blob instead of replacement-decoding it', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      writeFileSync(join(dir, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
      fixtureGit(dir, ['add', 'invalid.txt']);
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === 'invalid.txt',
      )!.target;

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toThrow(/UTF-8/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses NUL binary data from a Git-backed blob', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      writeFileSync(join(dir, 'tracked.bin'), Buffer.from([0x61, 0x00, 0x62]));
      fixtureGit(dir, ['add', 'tracked.bin']);
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === 'tracked.bin',
      )!.target;

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(TextDiffUnavailableError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a Git-backed blob larger than 5 MiB before returning partial text', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      write(dir, 'large staged.txt', 'x'.repeat(DIFF_CONTENT_MAX_BYTES + 1));
      fixtureGit(dir, ['add', 'large staged.txt']);
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === 'large staged.txt',
      )!.target;

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toThrow(/exceeds/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a distinct stale error when an untracked file changes after inspection', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'untracked file.txt',
      )!.target;
      write(dir, 'untracked file.txt', 'changed after inspection\n');

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(StaleDiffTargetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a distinct stale error when a pending file moves after inspection', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'untracked file.txt',
      )!.target;
      renameSync(join(dir, 'untracked file.txt'), join(dir, 'moved.txt'));

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(StaleDiffTargetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a distinct stale error when an unstaged file is staged after inspection', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).unstaged.find(
        (file) => file.path === 'unstaged.txt',
      )!.target;
      fixtureGit(dir, ['add', 'unstaged.txt']);

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(StaleDiffTargetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a distinct stale error when an untracked file is committed after inspection', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'untracked file.txt',
      )!.target;
      commit(dir, 'commit pending file');

      await expect(
        prepareDiff(defaultGitRunner, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(StaleDiffTargetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a Git validation failure as unavailable rather than stale', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).staged.find(
        (file) => file.path === 'value.txt',
      )!.target;
      const failingValidationGit: GitRunner = async (args, cwd, options) => {
        if (args[0] === 'rev-parse' && args.includes('HEAD^{commit}')) {
          return {
            stdout: '',
            stderr: 'fatal: cannot read repository state',
            exitCode: 128,
          };
        }
        return defaultGitRunner(args, cwd, options);
      };

      const error = await prepareDiff(
        failingValidationGit,
        target,
        workingFile,
        diffContentGit,
      ).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(TextDiffUnavailableError);
      expect(error).not.toBeInstanceOf(StaleDiffTargetError);
      expect(String(error)).toMatch(/cannot read repository state/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays stale when a working file changes after validation but before preparation', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).unstaged.find(
        (file) => file.path === 'value.txt',
      )!.target;
      let changed = false;
      const changingGit: GitRunner = async (args, cwd, options) => {
        if (!changed && args[0] === 'cat-file' && args[1] === '-s') {
          changed = true;
          write(dir, 'value.txt', 'changed after validation and before preparation\n');
        }
        return defaultGitRunner(args, cwd, options);
      };

      await expect(
        prepareDiff(changingGit, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(StaleDiffTargetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays stale when a working file disappears after validation but before preparation', async () => {
    const { dir, spec } = createWorktreeFixture();
    try {
      const target = (await inspectWorktree(defaultGitRunner, spec)).unstaged.find(
        (file) => file.path === 'value.txt',
      )!.target;
      let removed = false;
      const removingGit: GitRunner = async (args, cwd, options) => {
        if (!removed && args[0] === 'cat-file' && args[1] === '-s') {
          removed = true;
          rmSync(join(dir, 'value.txt'));
        }
        return defaultGitRunner(args, cwd, options);
      };

      await expect(
        prepareDiff(removingGit, target, workingFile, diffContentGit),
      ).rejects.toBeInstanceOf(StaleDiffTargetError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders an outside-target symlink as link text without reading its target', async () => {
    const { dir, spec } = createWorktreeFixture();
    const outside = mkdtempSync(join(tmpdir(), 'karst-diff-outside-'));
    try {
      const targetPath = join(outside, 'secret.bin');
      writeFileSync(targetPath, Buffer.from([0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0x00]));
      symlinkSync(targetPath, join(dir, 'outside-link'));
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'outside-link',
      )!.target;
      const reads: string[] = [];

      const prepared = await prepareDiff(defaultGitRunner, target, {
        ...workingFile,
        read: async (path: string) => {
          reads.push(path);
          return readFileSync(path);
        },
      });

      expect(prepared.right).toEqual({
        kind: 'virtual',
        label: 'outside-link (working tree)',
        content: targetPath,
      });
      expect(reads).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a regular resource reached through a parent symlink outside the real worktree', async () => {
    const { dir, spec } = createWorktreeFixture();
    const outside = mkdtempSync(join(tmpdir(), 'karst-diff-escape-'));
    try {
      write(dir, 'probe.txt', 'probe\n');
      write(outside, 'outside.txt', 'outside\n');
      symlinkSync(outside, join(dir, 'escape'));
      const target = (await inspectWorktree(defaultGitRunner, spec)).untracked.find(
        (file) => file.path === 'probe.txt',
      )!.target;
      target.right = {
        kind: 'working',
        path: join(dir, 'escape', 'outside.txt'),
        label: 'Working Tree',
      };
      target.binaryCheck = { kind: 'untracked', path: 'escape/outside.txt' };
      const reads: string[] = [];

      await expect(
        prepareDiff(defaultGitRunner, target, {
          ...workingFile,
          read: async (path: string) => {
            reads.push(path);
            return readFileSync(path);
          },
        }),
      ).rejects.toThrow(/outside the real worktree/i);
      expect(reads).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
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
