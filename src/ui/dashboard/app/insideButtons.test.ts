import { describe, expect, it } from 'vitest';
import { mainActionOf, type MenuFlags } from './insideSlices.js';
import { insideActionSentence } from './insideText.js';

const NONE: MenuFlags = { sendBack: false, retry: null, reset: null, prFeedback: false, ci: false, rebase: false, autofixStop: false, deliverFailures: false };

describe('mainActionOf', () => {
  it('returns null when the host offers no recovery action', () => {
    expect(mainActionOf(NONE)).toBeNull();
    // Reset, send back, stop and dismiss never become the main action.
    expect(mainActionOf({ ...NONE, reset: 'uat', sendBack: true, autofixStop: true, deliverFailures: true })).toBeNull();
  });

  it('picks each single action', () => {
    expect(mainActionOf({ ...NONE, retry: 'uat' })).toBe('retry');
    expect(mainActionOf({ ...NONE, ci: true })).toBe('ci');
    expect(mainActionOf({ ...NONE, prFeedback: true })).toBe('prFeedback');
    expect(mainActionOf({ ...NONE, rebase: true })).toBe('rebase');
  });

  it('keeps the priority retry > ci > prFeedback > rebase', () => {
    const all: MenuFlags = { ...NONE, retry: 'uat', ci: true, prFeedback: true, rebase: true };
    expect(mainActionOf(all)).toBe('retry');
    expect(mainActionOf({ ...all, retry: null })).toBe('ci');
    expect(mainActionOf({ ...all, retry: null, ci: false })).toBe('prFeedback');
    expect(mainActionOf({ ...all, retry: null, ci: false, prFeedback: false })).toBe('rebase');
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
