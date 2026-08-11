import { describe, it, expect } from 'vitest';
import type { GitRunner } from '../integrations/git.js';
import {
  collectPrDiffContext,
  PR_DIFF_MAX_CHARS,
  PR_LOG_MAX_CHARS,
  PR_STAT_MAX_CHARS,
} from './prDiffContext.js';

function fakeGit(answers: Record<string, { stdout?: string; exitCode?: number }>): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    // Key on the first two args: `diff --stat` and `diff --no-ext-diff` both
    // start with `diff`, so args[0] alone cannot tell them apart.
    const answer = answers[args.slice(0, 2).join(' ')] ?? answers[args[0]!];
    if (!answer) return { stdout: '', stderr: '', exitCode: 0 };
    return {
      stdout: answer.stdout ?? '',
      stderr: answer.exitCode === undefined || answer.exitCode === 0 ? '' : 'boom',
      exitCode: answer.exitCode ?? 0,
    };
  };
  return { git, calls };
}

describe('collectPrDiffContext', () => {
  it('collects the branch commits, the pull-request diffstat, and the unified diff', async () => {
    const { git, calls } = fakeGit({
      log: { stdout: '* abc1234 fix: ship faster\n' },
      'diff --stat': { stdout: ' src/a.ts | 3 ++\n 1 file changed\n' },
      'diff': { stdout: 'diff --git a/src/a.ts b/src/a.ts\n+hello\n' },
    });

    const ctx = await collectPrDiffContext(git, '/wt', 'develop');

    expect(ctx).toEqual({
      commits: '* abc1234 fix: ship faster',
      diffStat: ' src/a.ts | 3 ++\n 1 file changed',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+hello',
    });
    expect(calls.map((c) => c.slice(0, 4))).toEqual([
      ['log', '--oneline', 'origin/develop..HEAD'],
      ['diff', '--stat', 'origin/develop...HEAD'],
      ['diff', 'origin/develop...HEAD'],
    ]);
  });

  it('marks every truncated metadata section instead of presenting it as complete', async () => {
    const { git } = fakeGit({
      log: { stdout: 'a'.repeat(PR_LOG_MAX_CHARS + 1) },
      'diff --stat': { stdout: 's'.repeat(PR_STAT_MAX_CHARS + 1) },
      'diff': { stdout: 'd'.repeat(PR_DIFF_MAX_CHARS + 1) },
    });

    const ctx = await collectPrDiffContext(git, '/wt', 'develop');

    expect(ctx.commits).toHaveLength(PR_LOG_MAX_CHARS);
    expect(ctx.commitsTruncated).toBe(true);
    expect(ctx.diffStat).toHaveLength(PR_STAT_MAX_CHARS);
    expect(ctx.diffStatTruncated).toBe(true);
    expect(ctx.diff).toHaveLength(PR_DIFF_MAX_CHARS);
    expect(ctx.diffTruncated).toBe(true);
  });

  it('degrades per-piece when a git read fails — a broken diff read never throws', async () => {
    const { git } = fakeGit({
      log: { stdout: '* a one\n' },
      'diff --stat': { exitCode: 128 },
      'diff': { exitCode: 128 },
    });

    const ctx = await collectPrDiffContext(git, '/wt', 'develop');

    expect(ctx.commits).toBe('* a one');
    expect(ctx.diffStat).toBeUndefined();
    expect(ctx.diff).toBeUndefined();
  });

  it('returns an empty context when nothing can be read', async () => {
    const { git } = fakeGit({
      log: { exitCode: 128 },
      'diff --stat': { exitCode: 128 },
      'diff': { exitCode: 128 },
    });

    expect(await collectPrDiffContext(git, '/wt', 'develop')).toEqual({});
  });
});
