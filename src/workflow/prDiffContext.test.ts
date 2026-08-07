import { describe, it, expect } from 'vitest';
import type { GitRunner } from '../integrations/git.js';
import { collectPrDiffContext, PR_DIFF_MAX_CHARS } from './prDiffContext.js';

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
  it('collects the branch commits, diffstat, and full diff against origin/<base>', async () => {
    const { git, calls } = fakeGit({
      log: { stdout: '* abc1234 fix: ship faster\n' },
      'diff --stat': { stdout: ' src/a.ts | 3 ++\n 1 file changed\n' },
      'diff --no-ext-diff': { stdout: '+export const fast = true;\n' },
    });

    const ctx = await collectPrDiffContext(git, '/wt', 'develop');

    expect(ctx).toEqual({
      commits: '* abc1234 fix: ship faster',
      diffStat: ' src/a.ts | 3 ++\n 1 file changed',
      diff: '+export const fast = true;',
      diffTruncated: undefined,
    });
    expect(calls.map((c) => c.slice(0, 4))).toEqual([
      ['log', '--oneline', 'origin/develop...HEAD'],
      ['diff', '--stat', 'origin/develop...HEAD'],
      ['diff', '--no-ext-diff', '--unified=3', 'origin/develop...HEAD'],
    ]);
  });

  it('truncates an oversized diff and says so', async () => {
    const { git } = fakeGit({
      log: { stdout: '* a one\n' },
      'diff --stat': { stdout: ' src/a.ts | 5 ++\n' },
      'diff --no-ext-diff': { stdout: '+'.repeat(PR_DIFF_MAX_CHARS + 5000) },
    });

    const ctx = await collectPrDiffContext(git, '/wt', 'develop');

    expect(ctx.diff!.length).toBe(PR_DIFF_MAX_CHARS);
    expect(ctx.diffTruncated).toBe(true);
    expect(ctx.diff!.endsWith('+'.repeat(PR_DIFF_MAX_CHARS))).toBe(true);
  });

  it('degrades per-piece when a git read fails — a broken diff read never throws', async () => {
    const { git } = fakeGit({
      log: { stdout: '* a one\n' },
      'diff --stat': { stdout: ' src/a.ts | 5 ++\n' },
      'diff --no-ext-diff': { exitCode: 128 },
    });

    const ctx = await collectPrDiffContext(git, '/wt', 'develop');

    expect(ctx.commits).toBe('* a one');
    expect(ctx.diffStat).toBe(' src/a.ts | 5 ++');
    expect(ctx.diff).toBeUndefined();
  });

  it('returns an empty context when nothing can be read', async () => {
    const { git } = fakeGit({
      log: { exitCode: 128 },
      'diff --stat': { exitCode: 128 },
      'diff --no-ext-diff': { exitCode: 128 },
    });

    expect(await collectPrDiffContext(git, '/wt', 'develop')).toEqual({});
  });
});
