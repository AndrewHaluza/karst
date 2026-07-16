import { describe, it, expect } from 'vitest';
import { countFixAttempts, fixAttemptsRemain, FIX_ATTEMPT_CAP } from './fixAttempts.js';

describe('countFixAttempts', () => {
  it('sums the gates’ failures — the fix stage never carries the count itself', () => {
    expect(
      countFixAttempts([
        { stageKey: 'uat', attempt: 1 },
        { stageKey: 'review', attempt: 2 },
        { stageKey: 'fix', attempt: 0 },
      ]),
    ).toBe(3);
  });

  it('ignores non-gate stages', () => {
    expect(
      countFixAttempts([
        { stageKey: 'scope', attempt: 5 },
        { stageKey: 'impl', attempt: 4 },
        { stageKey: 'uat', attempt: 1 },
      ]),
    ).toBe(1);
  });

  it('is zero for a ticket no gate has failed', () => {
    expect(countFixAttempts([{ stageKey: 'uat' }, { stageKey: 'review', attempt: 0 }])).toBe(0);
    expect(countFixAttempts([])).toBe(0);
  });
});

describe('fixAttemptsRemain', () => {
  it('allows auto-resume below the cap and stops at it', () => {
    expect(fixAttemptsRemain(0)).toBe(true);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP - 1)).toBe(true);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP)).toBe(false);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP + 1)).toBe(false);
  });
});
