import { describe, it, expect } from 'vitest';
import { toWorktreeSpecs } from './worktreeSpecs.js';

describe('toWorktreeSpecs', () => {
  it('renders each repo label through the display function', () => {
    const specs = toWorktreeSpecs(
      [{ repo: '/r/a', path: '/wt/a', branch: 'main', baseRef: 'develop' }],
      (repo) => `label:${repo}`,
    );

    expect(specs).toEqual([
      { label: 'label:/r/a', path: '/wt/a', branch: 'main', baseRef: 'develop' },
    ]);
  });

  it('keeps the persisted worktree fields untouched', () => {
    const specs = toWorktreeSpecs(
      [{ repo: '/r/a', path: '/wt/a', branch: null, baseRef: null }],
      () => 'a',
    );

    expect(specs[0]).toEqual({ label: 'a', path: '/wt/a', branch: null, baseRef: null });
  });

  it('disambiguates a label shared by two worktrees', () => {
    const specs = toWorktreeSpecs(
      [
        { repo: '/r/a', path: '/wt/one', branch: 'main', baseRef: 'develop' },
        { repo: '/r/a', path: '/wt/two', branch: 'main', baseRef: 'develop' },
      ],
      () => 'same',
    );

    expect(specs[0]!.label).not.toBe(specs[1]!.label);
  });
});
