import { describe, it, expect } from 'vitest';
import { sessionAction } from './sessionAction.js';

describe('sessionAction', () => {
  it('continues an interrupted interactive session (impl/fix with a captured id)', () => {
    // Case (a): mid-work interruption — resume the exact session, don't re-seed.
    expect(sessionAction({ sessionId: 'abc', stageCurrent: 'impl' })).toEqual({
      kind: 'continue',
      label: 'Continue',
    });
    expect(sessionAction({ sessionId: 'abc', stageCurrent: 'fix' })).toEqual({
      kind: 'continue',
      label: 'Continue',
    });
  });

  it('starts when a drafted ticket was never run (no session, still at scope)', () => {
    // Case (b): drafted-but-unstarted — nothing to resume, so START is correct.
    expect(sessionAction({ sessionId: null, stageCurrent: 'scope' })).toEqual({
      kind: 'start',
      label: 'Start',
    });
  });

  it('starts when no session exists yet', () => {
    // Case (c): fresh — no captured id at all.
    expect(sessionAction({ sessionId: null, stageCurrent: null })).toEqual({
      kind: 'start',
      label: 'Start',
    });
  });

  it('starts on non-interactive stages even with a captured id (no resume there)', () => {
    // A captured id at a gate stage is not resumable — a fresh, fully-seeded
    // session is correct, so the entry point reads START, not CONTINUE.
    expect(sessionAction({ sessionId: 'abc', stageCurrent: 'uat' }).kind).toBe('start');
    expect(sessionAction({ sessionId: 'abc', stageCurrent: 'review' }).kind).toBe('start');
  });
});
