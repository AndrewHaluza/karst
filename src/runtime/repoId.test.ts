import { describe, expect, it } from 'vitest';
import { canonicalRepoId, repoIdCollisions } from './repoId.js';

describe('canonicalRepoId', () => {
  it('lowercases the manifest name', () => {
    expect(canonicalRepoId('DBGW')).toBe('dbgw');
    expect(canonicalRepoId('web-contract')).toBe('web-contract');
  });

  it('is idempotent', () => {
    expect(canonicalRepoId(canonicalRepoId('BE'))).toBe('be');
  });
});

describe('repoIdCollisions', () => {
  it('reports names that differ only by case', () => {
    expect(repoIdCollisions(['BE', 'be', 'fe'])).toEqual([['BE', 'be']]);
  });

  it('is empty when every name has a distinct canonical form', () => {
    expect(repoIdCollisions(['BE', 'FE', 'web-contract'])).toEqual([]);
  });

  it('pairs each later name with the first that claimed the canonical form', () => {
    expect(repoIdCollisions(['BE', 'Be', 'bE'])).toEqual([
      ['BE', 'Be'],
      ['BE', 'bE'],
    ]);
  });
});
