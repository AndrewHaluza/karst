import { describe, expect, it } from 'vitest';
import { findPr, prView, runGh } from './ghStub.mjs';

const prs = [{ repo: 'app', number: 996, url: 'https://x.invalid/pull/996', status: 'open', headRef: 'karst/A', baseRef: 'main', mergeBlock: 'dirty' }];

describe('ghStub', () => {
  it('answers the dependency probe', () => {
    expect(runGh(['--version'], []).code).toBe(0);
    expect(runGh(['auth', 'status'], []).code).toBe(0);
    expect(runGh(['auth', 'token'], [])).toEqual({ code: 0, out: '', err: '' });
  });
  it('finds a PR by number, URL, branch and pull path', () => {
    for (const ref of ['996', 'https://x.invalid/pull/996', 'karst/A', 'https://other.invalid/o/r/pull/996']) expect(findPr(prs, ref)).toBe(prs[0]);
    expect(findPr(prs, '1')).toBeUndefined();
  });
  it('shows a conflicted PR as CONFLICTING and DIRTY', () => {
    const v = JSON.parse(runGh(['pr', 'view', '996', '--json', 'state'], prs).out);
    expect(v).toMatchObject({ state: 'OPEN', isDraft: false, headRefName: 'karst/A', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  });
  it('maps draft and merged status', () => {
    expect(prView({ status: 'draft' })).toMatchObject({ state: 'OPEN', isDraft: true });
    expect(prView({ status: 'merged' })).toMatchObject({ state: 'MERGED', mergedAt: expect.any(String) });
  });
  it('fails for an unknown PR and an unsupported command', () => {
    expect(runGh(['pr', 'view', '7'], prs).code).toBe(1);
    expect(runGh(['pr', 'merge', '996'], prs).code).toBe(1);
  });
});
