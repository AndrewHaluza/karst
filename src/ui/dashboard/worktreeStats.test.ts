import { describe, expect, it, vi } from 'vitest';
import type { GitRunner } from '../../integrations/git.js';
import type { WorktreeView } from '../../store/dashboard.js';
import { loadWorktreeStats, parseNumstat } from './worktreeStats.js';

const wt = (overrides: Partial<WorktreeView> = {}): WorktreeView => ({
  ticketId: 1,
  repo: '/repo/a',
  repoDisplay: '/repo/a',
  path: '/repo/a/.karst/worktrees/A',
  branch: 'karst/A',
  baseRef: 'develop',
  depsMode: 'inherited',
  ...overrides,
});

describe('parseNumstat', () => {
  it('sums text rows and ignores binary or malformed rows', () => {
    expect(
      parseNumstat('10\t2\tsrc/a.ts\n4\t0\tsrc/b.ts\n-\t-\tlogo.png\nbad\n'),
    ).toEqual({ additions: 14, deletions: 2 });
  });
});

describe('loadWorktreeStats', () => {
  it('diffs from the merge base with the REMOTE base, matching what a PR reports', async () => {
    const git: GitRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '200\t24\tsrc/a.ts\n', stderr: '', exitCode: 0 });

    await expect(loadWorktreeStats([wt()], git, vi.fn())).resolves.toEqual([
      { repo: '/repo/a', additions: 200, deletions: 24 },
    ]);
    expect(git).toHaveBeenNthCalledWith(
      1,
      ['merge-base', 'HEAD', 'origin/develop'],
      '/repo/a/.karst/worktrees/A',
    );
    expect(git).toHaveBeenNthCalledWith(
      2,
      ['diff', '--numstat', '--no-ext-diff', 'abc123', '--'],
      '/repo/a/.karst/worktrees/A',
    );
  });

  it('falls back to the local base branch when the remote-tracking ref is absent', async () => {
    const git: GitRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'Not a valid object name', exitCode: 128 })
      .mockResolvedValueOnce({ stdout: 'def456\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '5\t1\tsrc/a.ts\n', stderr: '', exitCode: 0 });

    await expect(loadWorktreeStats([wt()], git, vi.fn())).resolves.toEqual([
      { repo: '/repo/a', additions: 5, deletions: 1 },
    ]);
    expect(git).toHaveBeenNthCalledWith(
      2,
      ['merge-base', 'HEAD', 'develop'],
      '/repo/a/.karst/worktrees/A',
    );
    expect(git).toHaveBeenNthCalledWith(
      3,
      ['diff', '--numstat', '--no-ext-diff', 'def456', '--'],
      '/repo/a/.karst/worktrees/A',
    );
  });

  it('reports rather than guesses when neither base ref yields a merge base', async () => {
    const logError = vi.fn();
    const git: GitRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });

    await expect(loadWorktreeStats([wt()], git, logError)).resolves.toEqual([]);
    expect(git).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('skips a missing base and isolates failed or truncated worktrees', async () => {
    const logError = vi.fn();
    const git: GitRunner = vi
      .fn()
      // Both worktrees resolve their merge base first (they run concurrently),
      // then both diffs fail — one outright, one by overflowing the output bound.
      .mockResolvedValueOnce({ stdout: 'aaa\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'bbb\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'bad ref', exitCode: 128 })
      .mockResolvedValueOnce({
        stdout: '1\t1\tx\n',
        stdoutTruncated: true,
        stderr: '',
        exitCode: 0,
      });
    const rows = [
      wt({ repo: '/no-base', baseRef: null }),
      wt({ repo: '/failed', path: '/failed' }),
      wt({ repo: '/truncated', path: '/truncated' }),
    ];

    await expect(loadWorktreeStats(rows, git, logError)).resolves.toEqual([]);
    expect(git).toHaveBeenCalledTimes(4);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('isolates a runner rejection without losing successful sibling totals', async () => {
    const logError = vi.fn();
    const git: GitRunner = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ stdout: 'ccc\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '3\t1\ty\n', stderr: '', exitCode: 0 });

    await expect(
      loadWorktreeStats(
        [wt({ repo: '/failed', path: '/failed' }), wt({ repo: '/ok', path: '/ok' })],
        git,
        logError,
      ),
    ).resolves.toEqual([{ repo: '/ok', additions: 3, deletions: 1 }]);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('passes cancellation to Git and does not log an expected abort', async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const git: GitRunner = vi.fn(async (_args, _cwd, options) => {
      expect(options?.signal).toBe(controller.signal);
      await pending;
      return { stdout: '', stderr: 'git was aborted', exitCode: 1 };
    });
    const logError = vi.fn();

    const result = loadWorktreeStats([wt()], git, logError, controller.signal);
    controller.abort();
    finish();

    await expect(result).resolves.toEqual([]);
    expect(logError).not.toHaveBeenCalled();
  });
});
