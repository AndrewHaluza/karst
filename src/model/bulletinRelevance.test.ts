import { describe, it, expect } from 'vitest';
import { noteMatchesScope, pathsOverlap } from './bulletinRelevance.js';

describe('pathsOverlap', () => {
  it('matches equal paths and directory/file prefixes', () => {
    expect(pathsOverlap('src/store/prs.ts', 'src/store/prs.ts')).toBe(true);
    expect(pathsOverlap('src/store', 'src/store/prs.ts')).toBe(true);
    expect(pathsOverlap('src/store/prs.ts', 'src/store')).toBe(true);
  });

  it('does not match across a path-segment boundary', () => {
    expect(pathsOverlap('src/store', 'src/storage')).toBe(false);
    expect(pathsOverlap('src/a', 'src/ab')).toBe(false);
    expect(pathsOverlap('src/store/prs.ts', 'src/store/prComments.ts')).toBe(false);
  });
});

describe('noteMatchesScope', () => {
  const reader = { repos: ['api'], paths: ['src/store/prs.ts'] };

  it('matches when repos intersect and paths overlap', () => {
    expect(
      noteMatchesScope({ repos: ['api', 'web'], paths: ['src/store/prs.ts'] }, reader),
    ).toBe(true);
  });

  it('does not match when the repos do not intersect', () => {
    expect(noteMatchesScope({ repos: ['web'], paths: ['src/store/prs.ts'] }, reader)).toBe(false);
  });

  it('matches on repo alone when the note has no stamped paths', () => {
    expect(noteMatchesScope({ repos: ['api'], paths: null }, reader)).toBe(true);
    expect(noteMatchesScope({ repos: ['api'], paths: [] }, reader)).toBe(true);
  });

  it('matches on repo alone when the reader has no known paths', () => {
    expect(
      noteMatchesScope(
        { repos: ['api'], paths: ['src/other/x.ts'] },
        { repos: ['api'], paths: null },
      ),
    ).toBe(true);
  });

  it('does not match when repos intersect but paths do not overlap', () => {
    expect(
      noteMatchesScope({ repos: ['api'], paths: ['src/other/x.ts'] }, reader),
    ).toBe(false);
  });

  it('matches nothing when the note has no repos', () => {
    expect(noteMatchesScope({ repos: null, paths: null }, reader)).toBe(false);
    expect(noteMatchesScope({ repos: [], paths: null }, reader)).toBe(false);
  });
});
