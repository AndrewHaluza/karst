import { describe, it, expect } from 'vitest';
import type { GitResult, GitRunner } from '../integrations/git.js';
import { pullBaseRef } from './pullBase.js';

type Reply = Partial<GitResult>;

/** Scripted runner: keyed by the joined args, defaulting to a failure. */
function fakeGit(replies: Record<string, Reply>): {
  git: GitRunner;
  calls: { args: string[]; cwd: string }[];
} {
  const calls: { args: string[]; cwd: string }[] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    const r = replies[args.join(' ')] ?? { exitCode: 1, stderr: 'unscripted' };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { git, calls };
}

describe('pullBaseRef', () => {
  it('fast-forwards the local base branch and branches from it', async () => {
    const { git, calls } = fakeGit({ 'fetch origin develop:develop': { exitCode: 0 } });

    const result = await pullBaseRef(git, '/repo', 'develop');

    expect(result).toEqual({ startPoint: 'develop', refreshed: true, reason: null });
    // The ff refspec answered, so no second fetch and no rev-parse.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe('/repo');
  });

  // git refuses `<base>:<base>` when the branch is checked out (the common case:
  // the main working tree sits on develop). Fetching the remote-tracking ref
  // still works, so branch from `origin/<base>` instead of giving up.
  it('branches from origin/<base> when the fast-forward refspec is refused', async () => {
    const { git, calls } = fakeGit({
      'fetch origin develop:develop': {
        exitCode: 1,
        stderr: "fatal: refusing to fetch into branch 'refs/heads/develop' checked out",
      },
      'fetch origin develop': { exitCode: 0 },
      'rev-parse --verify --quiet origin/develop^{commit}': { exitCode: 0, stdout: 'abc123\n' },
    });

    const result = await pullBaseRef(git, '/repo', 'develop');

    expect(result).toEqual({ startPoint: 'origin/develop', refreshed: true, reason: null });
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'fetch origin develop:develop',
      'fetch origin develop',
      'rev-parse --verify --quiet origin/develop^{commit}',
    ]);
  });

  // A pull is an optimization: an unreachable remote must never block a ticket
  // from being created. The local base is still a legal start point.
  it('keeps the local base and reports the reason when the remote is unreachable', async () => {
    const { git } = fakeGit({
      'fetch origin develop:develop': { exitCode: 128, stderr: 'fatal: could not read from remote\n' },
      'fetch origin develop': { exitCode: 128, stderr: 'fatal: could not read from remote\n' },
    });

    const result = await pullBaseRef(git, '/repo', 'develop');

    expect(result.startPoint).toBe('develop');
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBe('fatal: could not read from remote');
  });

  // A repo with no `origin` (or a base that exists only locally) fetches
  // nothing useful — `origin/<base>` would not resolve, so branching from it
  // would fail the worktree create outright.
  it('keeps the local base when origin/<base> does not resolve after the fetch', async () => {
    const { git } = fakeGit({
      'fetch origin develop:develop': { exitCode: 1, stderr: 'refused' },
      'fetch origin develop': { exitCode: 0 },
      'rev-parse --verify --quiet origin/develop^{commit}': { exitCode: 1, stderr: '' },
    });

    const result = await pullBaseRef(git, '/repo', 'develop');

    expect(result.startPoint).toBe('develop');
    expect(result.refreshed).toBe(false);
    expect(result.reason).toMatch(/origin\/develop/);
  });

  // git prose is unbounded and lands in a user-facing warning — one line, capped.
  it('reduces git prose to a single bounded line', async () => {
    const { git } = fakeGit({
      'fetch origin develop:develop': { exitCode: 1, stderr: `${'x'.repeat(400)}\nsecond line\n` },
      'fetch origin develop': { exitCode: 1, stderr: `${'x'.repeat(400)}\nsecond line\n` },
    });

    const result = await pullBaseRef(git, '/repo', 'develop');

    expect(result.reason).not.toContain('second line');
    expect(result.reason!.length).toBeLessThanOrEqual(200);
  });

  // Nothing to refresh, and `git fetch origin :` is not a question worth asking.
  it('does nothing when the base ref is blank', async () => {
    const { git, calls } = fakeGit({});

    const result = await pullBaseRef(git, '/repo', '  ');

    expect(result).toEqual({ startPoint: '  ', refreshed: false, reason: null });
    expect(calls).toEqual([]);
  });
});
