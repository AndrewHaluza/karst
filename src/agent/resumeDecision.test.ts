import { describe, it, expect } from 'vitest';
import { shouldResumeSession } from './resumeDecision.js';

describe('shouldResumeSession', () => {
  it('resumes when an interactive stage has a captured session', () => {
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'impl' })).toBe(true);
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'fix' })).toBe(true);
  });
  it('does not resume without a session id', () => {
    expect(shouldResumeSession({ sessionId: null, stageCurrent: 'impl' })).toBe(false);
  });
  it('does not resume on non-interactive stages', () => {
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'uat' })).toBe(false);
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'scope' })).toBe(false);
  });
});
