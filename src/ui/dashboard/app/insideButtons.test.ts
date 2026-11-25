import { describe, expect, it } from 'vitest';
import { mainActionOf, type MenuFlags } from './insideSlices.js';
import { insideActionSentence } from './insideText.js';

const NONE: MenuFlags = { sendBack: false, retry: null, reset: null, prFeedback: false, ci: false, gateFailure: false, rebase: false, autofixStop: false, deliverFailures: false };

describe('mainActionOf', () => {
  it('returns null when the host offers no recovery action', () => {
    expect(mainActionOf(NONE)).toBeNull();
    // Reset, re-run, send back, stop and dismiss never become the main action: re-run stays in Actions,
    // never a header button beside the banner's Resume (DB-4).
    expect(mainActionOf({ ...NONE, reset: 'uat', retry: 'uat', sendBack: true, autofixStop: true, deliverFailures: true })).toBeNull();
  });

  it('picks each single action', () => {
    expect(mainActionOf({ ...NONE, ci: true })).toBe('ci');
    expect(mainActionOf({ ...NONE, prFeedback: true })).toBe('prFeedback');
    expect(mainActionOf({ ...NONE, rebase: true })).toBe('rebase');
  });

  it('keeps the priority ci > prFeedback > rebase, and never picks re-run', () => {
    const all: MenuFlags = { ...NONE, retry: 'uat', ci: true, prFeedback: true, rebase: true };
    expect(mainActionOf(all)).toBe('ci');
    expect(mainActionOf({ ...all, ci: false })).toBe('prFeedback');
    expect(mainActionOf({ ...all, ci: false, prFeedback: false })).toBe('rebase');
    expect(mainActionOf({ ...all, ci: false, prFeedback: false, rebase: false })).toBeNull();
  });
});

describe('insideActionSentence', () => {
  it('starts with the visible label and lowercases the first letter of the sentence', () => {
    expect(insideActionSentence('Push', 'Sync the sandbox, then push')).toBe('Push — sync the sandbox, then push');
  });

  it('returns the label alone when there is no sentence', () => {
    expect(insideActionSentence('Retry', undefined)).toBe('Retry');
    expect(insideActionSentence('Retry', '')).toBe('Retry');
  });
});
