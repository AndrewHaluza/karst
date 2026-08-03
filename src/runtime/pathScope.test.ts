import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { isPathUnder, canonicalPath } from './pathScope.js';

describe('isPathUnder', () => {
  const root = join('/tmp', 'repo', '.karst', 'worktrees', 'abc');

  it('is true for the root itself', () => {
    expect(isPathUnder(root, root)).toBe(true);
  });

  it('is true for a descendant', () => {
    expect(isPathUnder(join(root, 'src', 'x'), root)).toBe(true);
  });

  it('is false for a sibling whose name merely shares the prefix', () => {
    // Slug disambiguation produces exactly this shape (`abc`, `abc-2`), so a
    // prefix match here would kill an unrelated ticket's server.
    expect(isPathUnder(`${root}-2`, root)).toBe(false);
  });

  it('is false for an unrelated path', () => {
    expect(isPathUnder(join('/tmp', 'other'), root)).toBe(false);
  });

  it('canonicalizes both sides before comparing', () => {
    expect(isPathUnder(join(root, '.', 'src'), root)).toBe(true);
  });
});

describe('canonicalPath', () => {
  it('returns a path whose missing tail is preserved', () => {
    const p = join('/tmp', 'definitely-not-here-9f2', 'deep', 'leaf');
    expect(canonicalPath(p).endsWith(join('deep', 'leaf'))).toBe(true);
  });
});
