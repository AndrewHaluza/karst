import { describe, expect, it } from 'vitest';
import type { GitResult, GitRunner } from '../integrations/git.js';
import { rebaseWorktreeOntoBase } from './rebaseWorktree.js';

const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): GitResult => ({ stdout: '', stderr, exitCode });

/**
 * Scripts one reply per `git` sub-command and records the call order. Keys are
 * matched as a prefix of the joined argv, longest key first, so a specific key
 * ('rev-parse --verify origin/epic/x') wins over a general one ('rev-parse').
 */
function scripted(replies: Record<string, GitResult>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const keys = Object.keys(replies).sort((a, b) => b.length - a.length);
  const git: GitRunner = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    for (const key of keys) if (line.startsWith(key)) return replies[key]!;
    return ok();
  };
  return { git, calls };
}

/** Both bases resolve as remote-tracking refs, the tree is clean, HEAD forked at `m1`. */
const HAPPY: Record<string, GitResult> = {
  'status --porcelain': ok(''),
  'rev-parse --verify origin/epic/x': ok('aaa\n'),
  'rev-parse --verify origin/develop': ok('bbb\n'),
  'merge-base': ok('m1\n'),
};

describe('rebaseWorktreeOntoBase', () => {
  it('is a no-op when the base has not changed', async () => {
    const { git, calls } = scripted({});
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'develop' });
    expect(r.outcome).toBe('already-based');
    expect(calls).toEqual([]);
  });

  it('refuses a dirty worktree before touching anything', async () => {
    const { git, calls } = scripted({ ...HAPPY, 'status --porcelain': ok(' M src/a.ts\n') });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('dirty');
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('ignores untracked files — build output is not a reason to refuse', async () => {
    const { git, calls } = scripted(HAPPY);
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('rebased');
    expect(calls).toContainEqual(['status', '--porcelain', '--untracked-files=no']);
  });

  it('rebases --onto the resolved new base from the branch point', async () => {
    const { git, calls } = scripted(HAPPY);
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('rebased');
    expect(calls).toContainEqual(['merge-base', 'HEAD', 'origin/develop']);
    expect(calls).toContainEqual(['rebase', '--onto', 'origin/epic/x', 'm1']);
  });

  it('fetches BOTH bases, so neither remote-tracking ref is stale', async () => {
    const { git, calls } = scripted(HAPPY);
    await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(calls).toContainEqual(['fetch', 'origin', 'epic/x']);
    expect(calls).toContainEqual(['fetch', 'origin', 'develop']);
  });

  it('uses a LOCAL-only base when the remote has no such branch', async () => {
    const { git, calls } = scripted({
      ...HAPPY,
      fetch: fail("couldn't find remote ref epic/x"),
      'rev-parse --verify origin/epic/x': fail('unknown revision', 128),
      'rev-parse --verify epic/x': ok('ccc\n'),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('rebased');
    expect(calls).toContainEqual(['rebase', '--onto', 'epic/x', 'm1']);
  });

  it('rebases anyway when the fetch fails but both refs are already local', async () => {
    const { git } = scripted({ ...HAPPY, fetch: fail('could not resolve host github.com') });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('rebased');
  });

  it('refuses when the new base resolves nowhere', async () => {
    const { git, calls } = scripted({
      ...HAPPY,
      'rev-parse --verify origin/epic/x': fail('unknown revision', 128),
      'rev-parse --verify epic/x': fail('unknown revision', 128),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('base-missing');
    expect(r.reason).toContain('epic/x');
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('refuses when the OLD base resolves nowhere — the branch point is unknowable', async () => {
    const { git, calls } = scripted({
      ...HAPPY,
      'rev-parse --verify origin/develop': fail('unknown revision', 128),
      'rev-parse --verify develop': fail('unknown revision', 128),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('base-missing');
    expect(r.reason).toContain('develop');
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('falls back to the old base ref itself when no merge base exists', async () => {
    const { git, calls } = scripted({ ...HAPPY, 'merge-base': fail('no merge base', 1) });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('rebased');
    expect(calls).toContainEqual(['rebase', '--onto', 'origin/epic/x', 'origin/develop']);
  });

  it('classifies a conflict by rebase STATE, not by git prose, and aborts', async () => {
    const { git, calls } = scripted({
      ...HAPPY,
      // Deliberately NOT the English word "conflict": classification must not read prose.
      rebase: fail('konnte nicht anwenden: 1a2b3c'),
      'rev-parse --verify --quiet REBASE_HEAD': ok('deadbeef\n'),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('conflict');
    expect(r.reason).toContain('konnte nicht anwenden');
    expect(calls).toContainEqual(['rebase', '--abort']);
  });

  it('does NOT abort when no rebase ever started', async () => {
    const { git, calls } = scripted({
      ...HAPPY,
      rebase: fail('fatal: invalid upstream', 128),
      'rev-parse --verify --quiet REBASE_HEAD': fail('', 1),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('failed');
    expect(calls).not.toContainEqual(['rebase', '--abort']);
  });

  it('reports a failed abort instead of swallowing it — the tree is left mid-rebase', async () => {
    const { git } = scripted({
      ...HAPPY,
      rebase: fail('could not apply 1a2b3c'),
      'rebase --abort': fail('fatal: could not move back to refs/heads/x', 128),
      'rev-parse --verify --quiet REBASE_HEAD': ok('deadbeef\n'),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('could not move back');
  });
});
