import { describe, it, expect, vi } from 'vitest';
import { parseOnboardingMessage, routeOnboardingAction, type OnboardingActions } from './messages.js';
import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';

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
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null,
    });
    // repos + approach + agent + model + agentProvider carried through when present
    expect(
      parseOnboardingMessage({
        type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null,
      }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null,
    });
  });

  it('accepts a well-formed save message, mirroring submit validation', () => {
    expect(
      parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null,
    });
    expect(
      parseOnboardingMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null,
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null,
    });
    expect(parseOnboardingMessage({ type: 'save', title: 't', description: 'd' })).toBeNull(); // missing key
    expect(parseOnboardingMessage({ type: 'save', key: 'P-1', description: 'd' })).toBeNull(); // missing title
    expect(parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't' })).toBeNull(); // missing description
  });

  // A blank key is valid — manual ticket creation leaves it to be generated
  // at persist time (actions.ts persistDraft). The field must still be
  // PRESENT (a string); only a wholly absent key is rejected (see the
  // "rejects malformed shapes" test below).
  it('accepts an empty key — manual creation generates one at persist time', () => {
    expect(
      parseOnboardingMessage({ type: 'submit', key: '', title: 't', description: 'd' }),
    ).toEqual({
      type: 'submit', key: '', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null,
    });
    expect(
      parseOnboardingMessage({ type: 'save', key: '', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: '', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null,
    });
  });

  it('accepts a well-formed set-agent message', () => {
    expect(parseOnboardingMessage({ type: 'set-agent', id: 'reviewer' })).toEqual({
      type: 'set-agent',
      id: 'reviewer',
    });
  });

  it('accepts set-type, including the empty "inherit" choice', () => {
    expect(parseOnboardingMessage({ type: 'set-type', id: 'fix' })).toEqual({
      type: 'set-type',
      id: 'fix',
    });
    expect(parseOnboardingMessage({ type: 'set-type', id: '' })).toEqual({
      type: 'set-type',
      id: '',
    });
    expect(parseOnboardingMessage({ type: 'set-type', id: 7 })).toBeNull();
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

  it('accepts set-provider, including the empty "inherit" choice', () => {
    expect(parseOnboardingMessage({ type: 'set-provider', id: 'codex' })).toEqual({
      type: 'set-provider',
      id: 'codex',
    });
    expect(parseOnboardingMessage({ type: 'set-provider', id: '' })).toEqual({
      type: 'set-provider',
      id: '',
    });
  });

  // The webview is a trust boundary: an unrecognized provider id must never
  // reach resolveAdapter's FACTORIES lookup (a TypeError there would crash
  // the openSession command handler before its own guards run).
  it('rejects a set-provider message with an unrecognized provider id', () => {
    expect(parseOnboardingMessage({ type: 'set-provider', id: 'evil' })).toBeNull();
  });

  it('degrades an unrecognized agentProvider on submit/save to null rather than rejecting the whole message', () => {
    expect(
      parseOnboardingMessage({
        type: 'submit', key: 'P-1', title: 't', description: 'd', agentProvider: 'evil', ticketType: null,
      }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null,
    });
    expect(
      parseOnboardingMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', agentProvider: 'evil', ticketType: null,
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null,
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
      setType: vi.fn(),
      setProvider: vi.fn(),
      analyze: vi.fn(),
      attachPick: vi.fn(),
      attachBytes: vi.fn(),
      detachAttachment: vi.fn(),
      openAttachment: vi.fn(),
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
      { type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex' },
      actions,
    );
    routeOnboardingAction({ type: 'analyze', prompt: 'go' }, actions);
    routeOnboardingAction({ type: 'set-agent', id: 'reviewer' }, actions);
    routeOnboardingAction({ type: 'set-model', id: 'claude-sonnet-5' }, actions);
    routeOnboardingAction({ type: 'set-provider', id: 'antigravity' }, actions);
    routeOnboardingAction({ type: 'set-type', id: 'fix' }, actions);
    routeOnboardingAction({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' }, actions);
    expect(actions.fetchSource).toHaveBeenCalledWith('CU-1');
    expect(actions.saveSignals).toHaveBeenCalledWith('be', ['api']);
    expect(actions.submit).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null,
    });
    expect(actions.analyze).toHaveBeenCalledWith('go');
    expect(actions.setAgent).toHaveBeenCalledWith('reviewer');
    expect(actions.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(actions.setProvider).toHaveBeenCalledWith('antigravity');
    expect(actions.setType).toHaveBeenCalledWith('fix');
    expect(actions.openTicketLink).toHaveBeenCalledWith('https://app.clickup.com/t/CU-1');
  });

  it('routes a valid save message to the save action', () => {
    const actions = spyActions();
    routeOnboardingAction(
      { type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex' },
      actions,
    );
    expect(actions.save).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null,
    });
  });

  it('does not fall through from set-provider into set-type', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'set-provider', id: 'codex' }, actions);
    expect(actions.setProvider).toHaveBeenCalledWith('codex');
    expect(actions.setType).not.toHaveBeenCalled();
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

describe('attachment messages', () => {
  function spyActions(): OnboardingActions {
    return {
      fetchSource: vi.fn(),
      suggestSignals: vi.fn(),
      saveSignals: vi.fn(),
      setRepos: vi.fn(),
      setApproach: vi.fn(),
      setAgent: vi.fn(),
      setModel: vi.fn(),
      setType: vi.fn(),
      setProvider: vi.fn(),
      analyze: vi.fn(),
      openTicketLink: vi.fn(),
      submit: vi.fn(),
      save: vi.fn(),
      requestState: vi.fn(),
      attachPick: vi.fn(),
      attachBytes: vi.fn(),
      detachAttachment: vi.fn(),
      openAttachment: vi.fn(),
    };
  }

  it('routes attach-pick', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'attach-pick' }, actions);
    expect(actions.attachPick).toHaveBeenCalled();
  });

  it('routes a well-formed attach-bytes', () => {
    const actions = spyActions();
    routeOnboardingAction(
      { type: 'attach-bytes', name: 'shot.png', base64: 'AAAA' }, actions,
    );
    expect(actions.attachBytes).toHaveBeenCalledWith('shot.png', 'AAAA');
  });

  it('ignores attach-bytes with a non-string name or payload', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'attach-bytes', name: 1, base64: 'AAAA' }, actions);
    routeOnboardingAction({ type: 'attach-bytes', name: 'a.png', base64: null }, actions);
    routeOnboardingAction({ type: 'attach-bytes', name: 'a.png' }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  it('ignores attach-bytes with an empty name', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'attach-bytes', name: '', base64: 'AAAA' }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  // The webview caps this too. Re-checked here because argv from a webview is
  // never trusted on the grounds that the webview already checked it — the same
  // rule the CLI's stage/phase split exists for.
  it('ignores attach-bytes whose payload exceeds the paste cap', () => {
    const actions = spyActions();
    // 4 base64 chars per 3 bytes, so this decodes to just over the cap.
    const oversize = 'A'.repeat(Math.ceil((MAX_PASTE_BYTES + 1024) / 3) * 4);
    routeOnboardingAction({ type: 'attach-bytes', name: 'a.png', base64: oversize }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  it('routes detach-attachment and open-attachment with a numeric id', () => {
    const actions = spyActions();
    routeOnboardingAction({ type: 'detach-attachment', id: 7 }, actions);
    routeOnboardingAction({ type: 'open-attachment', id: 7 }, actions);
    expect(actions.detachAttachment).toHaveBeenCalledWith(7);
    expect(actions.openAttachment).toHaveBeenCalledWith(7);
  });

  it('ignores a detach/open whose id is not a positive integer', () => {
    const actions = spyActions();
    for (const id of ['7', 0, -1, 1.5, NaN, null, undefined]) {
      routeOnboardingAction({ type: 'detach-attachment', id }, actions);
      routeOnboardingAction({ type: 'open-attachment', id }, actions);
    }
    expect(actions.detachAttachment).not.toHaveBeenCalled();
    expect(actions.openAttachment).not.toHaveBeenCalled();
  });
});
