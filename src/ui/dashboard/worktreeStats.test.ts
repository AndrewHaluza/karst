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
  it('runs one base-to-working-tree numstat diff and returns repo-keyed totals', async () => {
    const git: GitRunner = vi.fn().mockResolvedValue({
      stdout: '200\t24\tsrc/a.ts\n',
      stderr: '',
      exitCode: 0,
    });

    await expect(loadWorktreeStats([wt()], git, vi.fn())).resolves.toEqual([
      { repo: '/repo/a', additions: 200, deletions: 24 },
    ]);
    expect(git).toHaveBeenCalledWith(
      ['diff', '--numstat', '--no-ext-diff', 'develop', '--'],
      '/repo/a/.karst/worktrees/A',
    );
  });

  it('skips a missing base and isolates failed or truncated worktrees', async () => {
    const logError = vi.fn();
    const git: GitRunner = vi
      .fn()
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
    expect(git).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('isolates a runner rejection without losing successful sibling totals', async () => {
    const logError = vi.fn();
    const git: GitRunner = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
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
