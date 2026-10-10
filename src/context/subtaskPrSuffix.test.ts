import { describe, it, expect } from 'vitest';
import { subtaskPrSuffix } from './subtaskPrSuffix.js';

describe('subtaskPrSuffix', () => {
  it('formats one PR with base, status and merge check', () => {
    expect(
      subtaskPrSuffix('ship', [
        { repo: 'frontend', number: 12, url: null, status: 'open', baseRef: 'feat/root',
          mergeCheck: { state: 'clean', files: [], reason: null } },
      ]),
    ).toBe(' — frontend#12 → feat/root · open · merge: clean');
  });
  it('comma-joins several PRs', () => {
    expect(
      subtaskPrSuffix('ship', [
        { repo: 'api', number: 3, url: null, status: 'open', baseRef: 'develop' },
        { repo: 'web', number: 4, url: null, status: 'merged', baseRef: 'develop' },
      ]),
    ).toBe(' — api#3 → develop · open, web#4 → develop · merged');
  });
  it('says no PR yet in ship', () => expect(subtaskPrSuffix('ship', [])).toBe(' — no PR yet'));
  it('says nothing before ship', () => expect(subtaskPrSuffix('impl', [])).toBe(''));
  it('says nothing for an unknown stage', () => expect(subtaskPrSuffix(null, [])).toBe(''));
  it('drops missing parts', () => {
    expect(subtaskPrSuffix('ship', [{ repo: 'api', number: null, url: null, status: null }])).toBe(' — api');
  });
});
