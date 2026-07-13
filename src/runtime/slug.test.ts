import { describe, it, expect } from 'vitest';
import { worktreeSlug } from './slug.js';

describe('worktreeSlug', () => {
  it('combines key + title, lowercased and dash-joined', () => {
    expect(worktreeSlug({ id: 142, key: 'PROJ-142', title: 'Add login' })).toBe(
      'proj-142-add-login',
    );
  });

  it('falls back to #id-derived base when key is null', () => {
    expect(worktreeSlug({ id: 7, key: null, title: 'Fix logout' })).toBe('7-fix-logout');
  });

  it('uses key only when title is null', () => {
    expect(worktreeSlug({ id: 3, key: 'PROJ-3', title: null })).toBe('proj-3');
  });

  it('strips unsafe filesystem/git characters', () => {
    expect(
      worktreeSlug({ id: 1, key: 'PROJ-1', title: 'feat/foo: bar ~baz^ ..qux?*' }),
    ).toBe('proj-1-feat-foo-bar-baz-qux');
  });

  it('collapses runs of separators and trims leading/trailing dashes', () => {
    expect(worktreeSlug({ id: 1, key: '  PROJ-1  ', title: '  a   b  ' })).toBe('proj-1-a-b');
  });

  it('drops non-ascii/unicode characters', () => {
    expect(worktreeSlug({ id: 9, key: 'PROJ-9', title: 'café → naïve' })).toBe('proj-9-caf-na-ve');
  });

  it('falls back to the id when the slug would be empty', () => {
    expect(worktreeSlug({ id: 5, key: null, title: '···' })).toBe('5');
    expect(worktreeSlug({ id: 8, key: '', title: '' })).toBe('8');
  });

  it('caps length at 60 characters', () => {
    const long = 'x'.repeat(200);
    const s = worktreeSlug({ id: 1, key: 'PROJ-1', title: long });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.startsWith('proj-1-')).toBe(true);
  });
});
