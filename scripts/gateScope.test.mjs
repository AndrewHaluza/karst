import { describe, it, expect } from 'vitest';
import { baseRefCandidates, BASE_CANDIDATES, changedSince, mergeBase, splitZ, uncommitted } from './gateScope.mjs';

describe('baseRefCandidates', () => {
  it('uses the fixed list when KARST_BASE_REF is unset', () => {
    expect(baseRefCandidates(undefined)).toEqual(BASE_CANDIDATES);
    expect(BASE_CANDIDATES[0]).toBe('origin/develop');
  });
  it('orders X, the sandbox clone ref, then origin/X', () => {
    expect(baseRefCandidates('feat')).toEqual(['feat', 'refs/karst/base/feat', 'origin/feat']);
  });
});

describe('mergeBase', () => {
  it('returns the first candidate that resolves', async () => {
    const seen = [];
    const gitFn = async (_cwd, args) => {
      seen.push(args[1]);
      return args[1] === 'refs/karst/base/x' ? 'abc123\n' : null;
    };
    expect(await mergeBase('.', 'x', gitFn)).toMatchObject({ sha: 'abc123' });
    expect(seen).toEqual(['x', 'refs/karst/base/x']);
  });
  it('returns a null sha and the refs tried when none resolves', async () => {
    const r = await mergeBase('.', 'x', async () => null);
    expect(r.sha).toBeNull();
    expect(r.tried).toEqual(['x', 'refs/karst/base/x', 'origin/x']);
  });
});

describe('changed sets', () => {
  const fake = (diff, untracked) => async (_cwd, args) => (args[0] === 'diff' ? diff : untracked);
  it('splits NUL lists', () => expect(splitZ('a\0b\0')).toEqual(['a', 'b']));
  it('merges tracked and untracked files without duplicates', async () => {
    expect(await changedSince('.', 'sha', fake('a\0b\0', 'b\0c\0'))).toEqual(['a', 'b', 'c']);
  });
  it('returns null when git fails', async () => {
    expect(await changedSince('.', 'sha', fake(null, ''))).toBeNull();
    expect(await uncommitted('.', fake('', null))).toBeNull();
  });
  it('diffs against HEAD for uncommitted files', async () => {
    let args;
    await uncommitted('.', async (_c, a) => ((args ??= a), ''));
    expect(args).toEqual(['diff', '--name-only', '-z', 'HEAD']);
  });
});
