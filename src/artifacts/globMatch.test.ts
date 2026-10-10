import { describe, expect, it } from 'vitest';

import type { TaggedOutput } from '../approaches/outputs.js';
import { globToRegExp, matchOutput } from './globMatch.js';

const m = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

describe('globToRegExp', () => {
  it('matches everything below a trailing /**', () => {
    expect(m('docs/plans/**', 'docs/plans/a.md')).toBe(true);
    expect(m('docs/plans/**', 'docs/plans/x/y/a.md')).toBe(true);
    expect(m('docs/plans/**', 'docs/other/a.md')).toBe(false);
  });
  it('* and ? stay inside one segment', () => {
    expect(m('rpi/*/plan/**', 'rpi/feat/plan/PLAN.md')).toBe(true);
    expect(m('rpi/*/plan/**', 'rpi/a/b/plan/PLAN.md')).toBe(false);
    expect(m('a/?.md', 'a/x.md')).toBe(true);
    expect(m('a/?.md', 'a/xy.md')).toBe(false);
  });
  it('**/ matches zero or more directories', () => {
    expect(m('**/PLAN.md', 'PLAN.md')).toBe(true);
    expect(m('**/PLAN.md', 'a/b/PLAN.md')).toBe(true);
  });
  it('supports {a,b} and [set], escapes dots', () => {
    expect(m('specs/*.{md,txt}', 'specs/a.txt')).toBe(true);
    expect(m('specs/*.{md,txt}', 'specs/a.js')).toBe(false);
    expect(m('f[!a]x', 'fbx')).toBe(true);
    expect(m('f[!a]x', 'fax')).toBe(false);
    expect(m('a.md', 'aXmd')).toBe(false);
  });
});

describe('matchOutput', () => {
  const outs: TaggedOutput[] = [
    { approachId: 'a', glob: 'docs/**', kind: 'plan' },
    { approachId: 'b', glob: 'docs/**', kind: 'spec' },
  ];
  it('returns the first matching entry', () => {
    expect(matchOutput(outs, 'docs/x.md')?.approachId).toBe('a');
  });
  it('returns undefined when nothing matches', () => {
    expect(matchOutput(outs, 'src/x.ts')).toBeUndefined();
  });
});
