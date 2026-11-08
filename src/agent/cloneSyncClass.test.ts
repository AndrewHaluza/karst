import { describe, expect, it } from 'vitest';
import { HAVE_ANCESTOR_OFFSETS, classifyCloneRelation, fetchSandboxBundleArgs, hostBundleHaves, resolveSandboxHead, sandboxHeadRef } from './cloneSyncClass.js';

const SHA = 'a'.repeat(40);

describe('private sandbox ref', () => {
  it('names the ref and builds the fetch args without touching FETCH_HEAD', () => {
    expect(sandboxHeadRef('feat/x')).toBe('refs/karst/sandbox/feat/x');
    expect(fetchSandboxBundleArgs('/b/out.bundle', 'feat/x')).toEqual([
      'fetch', '--no-write-fetch-head', '/b/out.bundle', '+refs/heads/feat/x:refs/karst/sandbox/feat/x',
    ]);
  });

  it('resolves the ref to a sha once', async () => {
    const seen: string[][] = [];
    const out = await resolveSandboxHead(async (args) => { seen.push(args); return { code: 0, stdout: `${SHA}\n` }; }, 'feat/x');
    expect(out).toEqual({ ok: true, sha: SHA });
    expect(seen).toEqual([['rev-parse', '--verify', '--quiet', 'refs/karst/sandbox/feat/x^{commit}']]);
  });

  it.each([{ code: 1, stdout: '' }, { code: 0, stdout: '' }, { code: 0, stdout: 'not-a-sha' }])('unreadable head %j is an error, never diverged', async (res) => {
    expect(await resolveSandboxHead(async () => res, 'feat/x')).toEqual({ ok: false, reason: 'cannot read the sandbox head' });
  });
});

describe('classifyCloneRelation', () => {
  const rel = (ancestors: Array<[string, string]>) =>
    classifyCloneRelation(SHA, async (o, n) => ancestors.some(([a, b]) => a === o && b === n));
  it('ahead when HEAD is an ancestor of the sandbox sha', async () => { expect(await rel([['HEAD', SHA]])).toBe('ahead'); });
  it('behind when the sandbox sha is an ancestor of HEAD', async () => { expect(await rel([[SHA, 'HEAD']])).toBe('behind'); });
  it('diverged when neither', async () => { expect(await rel([])).toBe('diverged'); });
});

describe('hostBundleHaves', () => {
  const sha = (tag: string): string => tag.padStart(40, '0');
  const HEAD = sha('1');
  const SANDBOX = sha('2');
  const line = (i: number): string => (i === 0 ? HEAD : sha(`a${i}`));
  const walk = (n: number): string => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n';
  const fakeGit = (opts: { sandbox: string | undefined; revList: { code: number; stdout: string } }) => {
    const calls: string[][] = [];
    const git = async (args: string[]): Promise<{ code: number; stdout: string }> => {
      calls.push(args);
      if (args[0] === 'rev-list') return opts.revList;
      if (args.includes('--verify')) return opts.sandbox === undefined ? { code: 1, stdout: '' } : { code: 0, stdout: `${opts.sandbox}\n` };
      return { code: 0, stdout: `${HEAD}\n` };
    };
    return { git, calls };
  };

  it('orders HEAD, sandbox ref, then sampled ancestors', async () => {
    const { git } = fakeGit({ sandbox: SANDBOX, revList: { code: 0, stdout: walk(1025) } });
    const got = await hostBundleHaves(git, 'feat');
    expect(got).toEqual([HEAD, SANDBOX, ...HAVE_ANCESTOR_OFFSETS.map(line)]);
    expect(got).toHaveLength(13);
  });

  it('a short history keeps only the existing offsets', async () => {
    const { git } = fakeGit({ sandbox: undefined, revList: { code: 0, stdout: walk(6) } });
    expect(await hostBundleHaves(git, 'feat')).toEqual([HEAD, line(1), line(2), line(4)]);
  });

  it('lists a sha once', async () => {
    const { git } = fakeGit({ sandbox: line(1), revList: { code: 0, stdout: walk(3) } });
    expect(await hostBundleHaves(git, 'feat')).toEqual([HEAD, line(1), line(2)]);
  });

  it('a failing rev-list adds nothing', async () => {
    const { git } = fakeGit({ sandbox: SANDBOX, revList: { code: 128, stdout: '' } });
    expect(await hostBundleHaves(git, 'feat')).toEqual([HEAD, SANDBOX]);
  });

  it('walks first-parent history with a bounded count', async () => {
    const { git, calls } = fakeGit({ sandbox: undefined, revList: { code: 0, stdout: walk(1) } });
    await hostBundleHaves(git, 'feat');
    expect(calls).toContainEqual(['rev-list', '--first-parent', '--max-count=1025', 'HEAD']);
  });
});
