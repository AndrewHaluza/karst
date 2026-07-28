import { describe, it, expect } from 'vitest';
import { sessionAction } from './sessionAction.js';

describe('sessionAction', () => {
  it('OPEN when the agent is live, regardless of stage', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'impl', agentState: 'running' }))
      .toEqual({ kind: 'open', label: 'Open', detail: 'session is live · jump to terminal' });
  });

  it('CONTINUE an interrupted impl/fix with a captured id from the same core', () => {
    expect(sessionAction(
      { sessionId: 'a', sessionProvider: 'claude', stageCurrent: 'impl', agentState: 'idle' },
      'claude',
    )).toEqual({ kind: 'continue', label: 'Continue', detail: 'resume impl' });
    expect(sessionAction(
      { sessionId: 'a', sessionProvider: 'codex', stageCurrent: 'fix', agentState: 'idle' },
      'codex',
    )).toEqual({ kind: 'continue', label: 'Continue', detail: 'resume fix' });
  });

  // The verb is a preview of openSession's `--resume` decision, so a session
  // the launching core cannot resolve must not advertise "Continue".
  it('START (re-seed) at impl/fix when the captured session belongs to another core', () => {
    expect(sessionAction(
      { sessionId: 'a', sessionProvider: 'codex', stageCurrent: 'impl', agentState: 'idle' },
      'claude',
    )).toEqual({ kind: 'start', label: 'Start', detail: 're-seed from context' });
  });

  it('START (re-seed) at impl/fix for an untagged legacy session', () => {
    expect(sessionAction(
      { sessionId: 'a', sessionProvider: null, stageCurrent: 'impl', agentState: 'idle' },
      'claude',
    )).toEqual({ kind: 'start', label: 'Start', detail: 're-seed from context' });
  });

  it('START (re-seed) at impl/fix when no id was captured', () => {
    expect(sessionAction({ sessionId: null, stageCurrent: 'impl' }))
      .toEqual({ kind: 'start', label: 'Start', detail: 're-seed from context' });
  });

  it('RESUME when parked at a gate/ship stage', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'uat' }))
      .toEqual({ kind: 'resume', label: 'Resume', detail: 'picks up at uat' });
    expect(sessionAction({ sessionId: null, stageCurrent: 'review' }))
      .toEqual({ kind: 'resume', label: 'Resume', detail: 'picks up at review' });
    expect(sessionAction({ sessionId: null, stageCurrent: 'ship' }).kind).toBe('resume');
  });

  it('REOPEN when done', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'done' }))
      .toEqual({ kind: 'reopen', label: 'Reopen', detail: 'shipped · follow-up session' });
  });

  it('START (fresh) for a draft — null/scope — naming the repo count', () => {
    expect(sessionAction({ sessionId: null, stageCurrent: null, selectedRepos: ['a', 'b'] }))
      .toEqual({ kind: 'start', label: 'Start', detail: 'fresh · scopes 2 repos' });
    expect(sessionAction({ sessionId: null, stageCurrent: 'scope', selectedRepos: ['a'] }))
      .toEqual({ kind: 'start', label: 'Start', detail: 'fresh · scopes 1 repo' });
    expect(sessionAction({ sessionId: null, stageCurrent: null }))
      .toEqual({ kind: 'start', label: 'Start', detail: 'fresh session' });
  });
});
