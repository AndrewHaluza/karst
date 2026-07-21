import { describe, it, expect, vi } from 'vitest';
import { parseOnboardingMessage, routeOnboardingAction, type OnboardingActions } from './messages.js';

describe('parseOnboardingMessage', () => {
  it('accepts a well-formed fetch-source message', () => {
    expect(parseOnboardingMessage({ type: 'fetch-source', ref: 'CU-1' })).toEqual({
      type: 'fetch-source',
      ref: 'CU-1',
    });
  });

  it('accepts suggest-signals and save-signals with validated fields', () => {
    expect(parseOnboardingMessage({ type: 'suggest-signals', service: 'fe' })).toEqual({
      type: 'suggest-signals',
      service: 'fe',
    });
    expect(
      parseOnboardingMessage({ type: 'save-signals', service: 'be', signals: ['api', 'db'] }),
    ).toEqual({ type: 'save-signals', service: 'be', signals: ['api', 'db'] });
  });

  it('accepts set-repos, set-approach, request-state, and submit', () => {
    expect(parseOnboardingMessage({ type: 'set-repos', repos: ['fe', 'be'] })).toEqual({
      type: 'set-repos',
      repos: ['fe', 'be'],
    });
    expect(parseOnboardingMessage({ type: 'set-approach', id: 'rpi' })).toEqual({
      type: 'set-approach',
      id: 'rpi',
    });
    expect(parseOnboardingMessage({ type: 'analyze', prompt: 'do the thing' })).toEqual({
      type: 'analyze',
      prompt: 'do the thing',
    });
    // empty prompt is allowed (host falls back to the persisted brief)
    expect(parseOnboardingMessage({ type: 'analyze', prompt: '' })).toEqual({
      type: 'analyze',
      prompt: '',
    });
    // a non-string prompt is rejected at the trust boundary
    expect(parseOnboardingMessage({ type: 'analyze' })).toBeNull();
    expect(
      parseOnboardingMessage({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' }),
    ).toEqual({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' });
    expect(parseOnboardingMessage({ type: 'request-state' })).toEqual({ type: 'request-state' });
    expect(
      parseOnboardingMessage({ type: 'submit', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null,
    });
    // repos + approach + agent + model carried through when present
    expect(
      parseOnboardingMessage({
        type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
      }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });
  });

  it('accepts a well-formed save message, mirroring submit validation', () => {
    expect(
      parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null,
    });
    expect(
      parseOnboardingMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });
    expect(parseOnboardingMessage({ type: 'save', title: 't', description: 'd' })).toBeNull(); // missing key
    expect(parseOnboardingMessage({ type: 'save', key: 'P-1', description: 'd' })).toBeNull(); // missing title
    expect(parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't' })).toBeNull(); // missing description
  });

  it('accepts a well-formed set-agent message', () => {
    expect(parseOnboardingMessage({ type: 'set-agent', id: 'reviewer' })).toEqual({
      type: 'set-agent',
      id: 'reviewer',
    });
  });

  it('accepts set-model, including the empty "inherit" choice', () => {
    expect(parseOnboardingMessage({ type: 'set-model', id: 'claude-sonnet-5' })).toEqual({
      type: 'set-model',
      id: 'claude-sonnet-5',
    });
    expect(parseOnboardingMessage({ type: 'set-model', id: '' })).toEqual({
      type: 'set-model',
      id: '',
    });
  });

  // open-ticket-link drives vscode.env.openExternal, so the scheme allowlist is
  // the trust boundary — not the non-empty-string check this used to carry. The
  // dashboard guarded this and onboarding didn't; both now share isHttpUrl.
  it('rejects a non-http(s) open-ticket-link url', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'command:foo', '']) {
      expect(parseOnboardingMessage({ type: 'open-ticket-link', url })).toBeNull();
    }
    expect(parseOnboardingMessage({ type: 'open-ticket-link' })).toBeNull();
    expect(parseOnboardingMessage({ type: 'open-ticket-link', url: 42 })).toBeNull();
  });

  it('rejects malformed shapes (trust boundary)', () => {
    expect(parseOnboardingMessage(null)).toBeNull();
    expect(parseOnboardingMessage({})).toBeNull();
    expect(parseOnboardingMessage({ type: 'unknown' })).toBeNull();
    expect(parseOnboardingMessage({ type: 'fetch-source' })).toBeNull(); // missing ref
    expect(parseOnboardingMessage({ type: 'save-signals', service: 'be' })).toBeNull(); // missing signals
    expect(
      parseOnboardingMessage({ type: 'save-signals', service: 'be', signals: [1, 2] }),
    ).toBeNull(); // non-string signals
    expect(parseOnboardingMessage({ type: 'set-repos', repos: 'fe' })).toBeNull(); // not an array
    expect(parseOnboardingMessage({ type: 'submit', title: 't' })).toBeNull(); // missing key
    expect(parseOnboardingMessage({ type: 'install-approach', id: 'rpi' })).toBeNull(); // removed message type
  });
});

describe('routeOnboardingAction', () => {
  function spyActions(): OnboardingActions {
    return {
      fetchSource: vi.fn(),
      suggestSignals: vi.fn(),
      saveSignals: vi.fn(),
      setRepos: vi.fn(),
      setApproach: vi.fn(),
      setAgent: vi.fn(),
      setModel: vi.fn(),
      analyze: vi.fn(),
      openTicketLink: vi.fn(),
      submit: vi.fn(),
      save: vi.fn(),
      requestState: vi.fn(),
    };
  }

  it('routes each valid message to its action', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'fetch-source', ref: 'CU-1' }, actions);
    routeOnboardingAction({ type: 'save-signals', service: 'be', signals: ['api'] }, actions);
    routeOnboardingAction(
      { type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8' },
      actions,
    );
    routeOnboardingAction({ type: 'analyze', prompt: 'go' }, actions);
    routeOnboardingAction({ type: 'set-agent', id: 'reviewer' }, actions);
    routeOnboardingAction({ type: 'set-model', id: 'claude-sonnet-5' }, actions);
    routeOnboardingAction({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' }, actions);
    expect(actions.fetchSource).toHaveBeenCalledWith('CU-1');
    expect(actions.saveSignals).toHaveBeenCalledWith('be', ['api']);
    expect(actions.submit).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });
    expect(actions.analyze).toHaveBeenCalledWith('go');
    expect(actions.setAgent).toHaveBeenCalledWith('reviewer');
    expect(actions.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(actions.openTicketLink).toHaveBeenCalledWith('https://app.clickup.com/t/CU-1');
  });

  it('routes a valid save message to the save action', () => {
    const actions = spyActions();
    routeOnboardingAction(
      { type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8' },
      actions,
    );
    expect(actions.save).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });
  });

  it('ignores install-approach (removed — install now lives in settings)', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'install-approach', id: 'rpi' }, actions);
    expect(actions.analyze).not.toHaveBeenCalled();
  });

  it('ignores malformed messages without throwing', () => {
    const actions = spyActions();
    expect(() => routeOnboardingAction({ type: 'nope' }, actions)).not.toThrow();
    expect(actions.fetchSource).not.toHaveBeenCalled();
  });
});
