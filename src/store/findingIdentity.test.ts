import { describe, it, expect } from 'vitest';
import { findingIdentity, normalizeFindingTitle } from './findingIdentity.js';

describe('normalizeFindingTitle', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeFindingTitle('  Missing   SNAPSHOT\tstep ')).toBe('missing snapshot step');
  });
  it('strips line numbers', () => {
    expect(normalizeFindingTitle('Dropped target at line 42')).toBe('dropped target at');
    expect(normalizeFindingTitle('Bad call (foo.ts:123:7)')).toBe('bad call (foo.ts)');
    expect(normalizeFindingTitle('Bad L99 call')).toBe('bad call');
  });
  it('strips quoted code', () => {
    expect(normalizeFindingTitle('`aggregateUat` is not called')).toBe('is not called');
    expect(normalizeFindingTitle('Uses "foo" and \'bar\' wrongly')).toBe('uses and wrongly');
  });
});

describe('findingIdentity', () => {
  const base = { repo: '/web', file: 'src/a.ts', title: 'No snapshot taken' };
  it('is a stable hex hash', () => {
    expect(findingIdentity(base)).toMatch(/^[0-9a-f]{40}$/);
    expect(findingIdentity(base)).toBe(findingIdentity({ ...base }));
  });
  it('ignores line, case, whitespace and quoted code', () => {
    const a = findingIdentity({ ...base, title: 'No `snap` taken at line 10' });
    const b = findingIdentity({ ...base, title: 'no   taken at line 99' });
    expect(a).toBe(b);
  });
  it('differs by repo, file and title', () => {
    const id = findingIdentity(base);
    expect(findingIdentity({ ...base, repo: '/api' })).not.toBe(id);
    expect(findingIdentity({ ...base, file: 'src/b.ts' })).not.toBe(id);
    expect(findingIdentity({ ...base, title: 'Other problem' })).not.toBe(id);
    expect(findingIdentity({ ...base, file: null })).not.toBe(id);
  });
});
