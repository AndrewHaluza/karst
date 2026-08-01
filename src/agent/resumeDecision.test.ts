import { describe, it, expect } from 'vitest';
import { shouldResumeSession } from './resumeDecision.js';

describe('shouldResumeSession', () => {
  it('resumes when an interactive stage has a session captured by the same provider', () => {
    expect(
      shouldResumeSession({
        sessionId: 'x',
        sessionProvider: 'claude',
        stageCurrent: 'impl',
        provider: 'claude',
      }),
    ).toBe(true);
    expect(
      shouldResumeSession({
        sessionId: 'x',
        sessionProvider: 'codex',
        stageCurrent: 'fix',
        provider: 'codex',
      }),
    ).toBe(true);
  });

  it('does not resume without a session id', () => {
    expect(
      shouldResumeSession({
        sessionId: null,
        sessionProvider: null,
        stageCurrent: 'impl',
        provider: 'claude',
      }),
    ).toBe(false);
  });

  it('does not resume on non-interactive stages', () => {
    for (const stage of ['uat', 'scope'] as const) {
      expect(
        shouldResumeSession({
          sessionId: 'x',
          sessionProvider: 'claude',
          stageCurrent: stage,
          provider: 'claude',
        }),
      ).toBe(false);
    }
  });

  // The bug this guard exists for: a session id is only meaningful to the agent
  // CLI that minted it. Handing Claude a Codex rollout id makes `--resume` fail
  // ("No conversation found") and the terminal dies on launch.
  it('does not resume a session captured by a different provider', () => {
    expect(
      shouldResumeSession({
        sessionId: 'codex-sess',
        sessionProvider: 'codex',
        stageCurrent: 'impl',
        provider: 'claude',
      }),
    ).toBe(false);
  });

  // Rows written before session_provider existed cannot be proven compatible,
  // so they are never resumed — a cold, fully-seeded session is always safe.
  it('does not resume a legacy session with no recorded provider', () => {
    expect(
      shouldResumeSession({
        sessionId: 'legacy-sess',
        sessionProvider: null,
        stageCurrent: 'impl',
        provider: 'claude',
      }),
    ).toBe(false);
  });

  // A switch launch must be fresh even if an earlier conversation belongs to
  // the newly selected provider. Otherwise A→B→A before B's SessionStart can
  // resurrect the retired A conversation from the still-captured session id.
  it('honors a host-only fresh-launch signal without changing ordinary continue behavior', () => {
    const sameProviderSession = {
      sessionId: 'retired-claude-session',
      sessionProvider: 'claude' as const,
      stageCurrent: 'impl' as const,
      provider: 'claude' as const,
    };

    expect(shouldResumeSession(sameProviderSession)).toBe(true);
    expect(shouldResumeSession({ ...sameProviderSession, allowResume: false })).toBe(false);
  });
});
