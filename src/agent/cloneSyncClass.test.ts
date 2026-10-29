import { describe, expect, it } from 'vitest';
import { classifyCloneRelation, fetchSandboxBundleArgs, resolveSandboxHead, sandboxHeadRef } from './cloneSyncClass.js';

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
