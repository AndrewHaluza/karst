import { describe, expect, it } from 'vitest';
import { parseNameStatus, parseStageTwoEntries } from './gitParsers.js';

describe('parseNameStatus unmerged paths', () => {
  it('marks an unmerged path as conflicted instead of a plain modification', () => {
    expect(parseNameStatus('U\0f.txt\0')).toEqual([
      { status: 'modified', path: 'f.txt', oldPath: null, conflicted: true },
    ]);
  });

  it('emits a conflicted path once even though Git reports it twice', () => {
    expect(parseNameStatus('U\0f.txt\0M\0f.txt\0')).toEqual([
      { status: 'modified', path: 'f.txt', oldPath: null, conflicted: true },
    ]);
  });

  it('drops an earlier plain record when the same path is later reported unmerged', () => {
    expect(parseNameStatus('M\0f.txt\0U\0f.txt\0')).toEqual([
      { status: 'modified', path: 'f.txt', oldPath: null, conflicted: true },
    ]);
  });

  it('keeps unrelated paths while collapsing the conflicted one', () => {
    expect(parseNameStatus('U\0f.txt\0M\0f.txt\0A\0other.txt\0')).toEqual([
      { status: 'modified', path: 'f.txt', oldPath: null, conflicted: true },
      { status: 'added', path: 'other.txt', oldPath: null },
    ]);
  });
});

describe('parseStageTwoEntries', () => {
  it('retains only the ours side of unmerged paths', () => {
    expect(
      parseStageTwoEntries(
        '100644 1111111111111111111111111111111111111111 0\tresolved.txt\0' +
          '100644 2222222222222222222222222222222222222222 1\tconflict.txt\0' +
          '100644 3333333333333333333333333333333333333333 2\tconflict.txt\0' +
          '100644 4444444444444444444444444444444444444444 3\tconflict.txt\0',
      ),
    ).toEqual(new Map([['conflict.txt', '3333333333333333333333333333333333333333']]));
  });

  it('rejects a duplicated ours entry rather than picking one', () => {
    expect(() =>
      parseStageTwoEntries(
        '100644 3333333333333333333333333333333333333333 2\tconflict.txt\0' +
          '100644 4444444444444444444444444444444444444444 2\tconflict.txt\0',
      ),
    ).toThrow(/duplicate/i);
  });

  it('returns an empty map for empty output', () => {
    expect(parseStageTwoEntries('')).toEqual(new Map());
  });
});
