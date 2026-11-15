import { describe, expect, it } from 'vitest';
import { ciNowView } from './ciNow.js';

const waiting = { label: 'extention', number: 1090, total: 14, passed: 13, pending: 1 };

describe('ciNowView (T1140)', () => {
  it('names the actor, the progress, and the next step for one PR', () => {
    expect(ciNowView({ waiting: [waiting], autofixEffective: true })).toEqual({
      now: 'Now: GitHub CI runs on extention #1090 — 13 of 14 passed, 1 pending. Nothing for you to do.',
      next: 'Next: all green → Merge. A red check → Auto-fix sends it to the agent.',
    });
  });

  it('says the user chooses when Auto-fix is off', () => {
    expect(ciNowView({ waiting: [waiting], autofixEffective: false })!.next).toBe('Next: all green → Merge. A red check → you choose.');
  });

  it('sums several PRs and names each', () => {
    const view = ciNowView({ waiting: [waiting, { label: 'web', number: 7, total: 4, passed: 1, pending: 3 }], autofixEffective: true });
    expect(view!.now).toBe('Now: GitHub CI runs on extention #1090, web #7 — 14 of 18 passed, 4 pending. Nothing for you to do.');
  });

  it('has no line when nothing waits', () => {
    expect(ciNowView({ waiting: [], autofixEffective: true })).toBeUndefined();
  });
});
