import { describe, it, expect } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { stallErrors, updateStallDetection, readStallDetection } from './qualityDraft.js';

const draftOf = (review?: object): Manifest => ({ review }) as unknown as Manifest;

describe('stallDetection draft', () => {
  it('reads defaults for an absent block', () => {
    expect(readStallDetection(draftOf())).toEqual({
      enabled: true,
      sameFileRounds: 3,
      repeatedFindingRounds: null,
    });
  });
  it('clamps the default sameFileRounds to a smaller maxFixAttempts', () => {
    expect(readStallDetection(draftOf({ maxFixAttempts: 2 })).sameFileRounds).toBe(2);
  });
  it('patches over defaults and keeps siblings', () => {
    const next = updateStallDetection(draftOf({ maxFixAttempts: 5, openChanges: true }), { enabled: false });
    expect(next.review).toMatchObject({
      maxFixAttempts: 5,
      openChanges: true,
      stallDetection: { enabled: false, sameFileRounds: 3, repeatedFindingRounds: null },
    });
  });
  it('flags values the host validator would refuse', () => {
    const review = { maxFixAttempts: 4 };
    expect(stallErrors({ enabled: true, sameFileRounds: 3, repeatedFindingRounds: null }, review.maxFixAttempts)).toEqual({});
    expect(stallErrors({ enabled: true, sameFileRounds: 0, repeatedFindingRounds: 5 }, 4)).toEqual({
      sameFileRounds: 'Enter a whole number from 1 to 4.',
      repeatedFindingRounds: 'Enter a whole number from 1 to 4, or leave blank.',
    });
    expect(stallErrors({ enabled: true, sameFileRounds: 1.5, repeatedFindingRounds: null }, 4).sameFileRounds).toBeDefined();
  });
  it('reports no errors while disabled', () => {
    expect(stallErrors({ enabled: false, sameFileRounds: 0, repeatedFindingRounds: 99 }, 3)).toEqual({});
  });
});
