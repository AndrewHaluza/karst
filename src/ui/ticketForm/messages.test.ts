import { describe, it, expect, vi } from 'vitest';
import { parseTicketFormMessage, routeTicketFormAction, type TicketFormActions } from './messages.js';
import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';

describe('parseTicketFormMessage', () => {
  it('accepts a well-formed fetch-source message', () => {
    expect(parseTicketFormMessage({ type: 'fetch-source', ref: 'CU-1' })).toEqual({
      type: 'fetch-source',
      ref: 'CU-1',
    });
  });

  it('accepts search-tickets with a blank query and a null status', () => {
    expect(parseTicketFormMessage({ type: 'search-tickets', query: '', status: null })).toEqual({
      type: 'search-tickets',
      query: '',
      status: null,
    });
    expect(
      parseTicketFormMessage({ type: 'search-tickets', query: 'pay', status: 'to do' }),
    ).toEqual({ type: 'search-tickets', query: 'pay', status: 'to do' });
  });

  it('rejects malformed search-tickets at the trust boundary', () => {
    expect(parseTicketFormMessage({ type: 'search-tickets' })).toBeNull(); // missing query
    expect(parseTicketFormMessage({ type: 'search-tickets', query: 7, status: null })).toBeNull();
    expect(
      parseTicketFormMessage({ type: 'search-tickets', query: 'pay', status: 7 }),
    ).toBeNull(); // status must be a string or null
    // A crafted page must not send an unbounded query to a network call.
    expect(
      parseTicketFormMessage({ type: 'search-tickets', query: 'x'.repeat(201), status: null }),
    ).toBeNull();
    // An absent status is not the same as null — it is rejected.
    expect(parseTicketFormMessage({ type: 'search-tickets', query: 'pay' })).toBeNull();
  });

  it('accepts search-statuses', () => {
    expect(parseTicketFormMessage({ type: 'search-statuses' })).toEqual({ type: 'search-statuses' });
  });

  it('accepts suggest-signals and save-signals with validated fields', () => {
    expect(parseTicketFormMessage({ type: 'suggest-signals', service: 'fe' })).toEqual({
      type: 'suggest-signals',
      service: 'fe',
    });
    expect(
      parseTicketFormMessage({ type: 'save-signals', service: 'be', signals: ['api', 'db'] }),
    ).toEqual({ type: 'save-signals', service: 'be', signals: ['api', 'db'] });
  });

  it('accepts set-repos, set-approach, request-state, and submit', () => {
    expect(parseTicketFormMessage({ type: 'set-repos', repos: ['fe', 'be'] })).toEqual({
      type: 'set-repos',
      repos: ['fe', 'be'],
    });
    expect(parseTicketFormMessage({ type: 'set-approach', id: 'rpi' })).toEqual({
      type: 'set-approach',
      id: 'rpi',
    });
    expect(parseTicketFormMessage({ type: 'analyze', prompt: 'do the thing' })).toEqual({
      type: 'analyze',
      prompt: 'do the thing',
    });
    // empty prompt is allowed (host falls back to the persisted brief)
    expect(parseTicketFormMessage({ type: 'analyze', prompt: '' })).toEqual({
      type: 'analyze',
      prompt: '',
    });
    // a non-string prompt is rejected at the trust boundary
    expect(parseTicketFormMessage({ type: 'analyze' })).toBeNull();
    expect(
      parseTicketFormMessage({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' }),
    ).toEqual({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' });
    expect(parseTicketFormMessage({ type: 'request-state' })).toEqual({ type: 'request-state' });
    // Cancel: the panel's own close affordance (the webview cannot dispose
    // itself — the host owns the panel).
    expect(parseTicketFormMessage({ type: 'close-form' })).toEqual({ type: 'close-form' });
    expect(
      parseTicketFormMessage({ type: 'submit', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null, createInProvider: false, pullBase: true,
    });
    // repos + approach + agent + model + agentProvider carried through when present
    expect(
      parseTicketFormMessage({
        type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null, createInProvider: false,
      }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null, createInProvider: false, pullBase: true,
    });
  });

  it('accepts a well-formed save message, mirroring submit validation', () => {
    expect(
      parseTicketFormMessage({ type: 'save', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null, createInProvider: false,
    });
    expect(
      parseTicketFormMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null, createInProvider: false,
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null, createInProvider: false,
    });
    expect(parseTicketFormMessage({ type: 'save', title: 't', description: 'd' })).toBeNull(); // missing key
    expect(parseTicketFormMessage({ type: 'save', key: 'P-1', description: 'd' })).toBeNull(); // missing title
    expect(parseTicketFormMessage({ type: 'save', key: 'P-1', title: 't' })).toBeNull(); // missing description
  });

  // A blank key is valid — manual ticket creation leaves it to be generated
  // at persist time (actions.ts persistDraft). The field must still be
  // PRESENT (a string); only a wholly absent key is rejected (see the
  // "rejects malformed shapes" test below).
  it('accepts an empty key — manual creation generates one at persist time', () => {
    expect(
      parseTicketFormMessage({ type: 'submit', key: '', title: 't', description: 'd' }),
    ).toEqual({
      type: 'submit', key: '', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null, createInProvider: false, pullBase: true,
    });
    expect(
      parseTicketFormMessage({ type: 'save', key: '', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: '', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null, createInProvider: false,
    });
  });

  // The pull switch (§ scope) rides `submit` only — it decides what the launch
  // branches from, and `save` launches nothing. ON unless the page explicitly
  // said false, so an older webview (or a stripped message) still refreshes.
  it('carries the pull switch on submit, defaulting ON for anything but an explicit false', () => {
    const base = { type: 'submit', key: 'P-1', title: 't', description: 'd' };
    expect(parseTicketFormMessage({ ...base, pullBase: false })).toMatchObject({
      type: 'submit',
      pullBase: false,
    });
    expect(parseTicketFormMessage({ ...base, pullBase: true })).toMatchObject({ pullBase: true });
    expect(parseTicketFormMessage(base)).toMatchObject({ pullBase: true });
    // A non-boolean is not a choice — it must not read as "skip the pull".
    expect(parseTicketFormMessage({ ...base, pullBase: 'no' })).toMatchObject({ pullBase: true });
    // `save` never launches, so it carries no switch at all.
    expect(parseTicketFormMessage({ ...base, type: 'save', pullBase: false })).not.toHaveProperty(
      'pullBase',
    );
  });

  it('carries the create-in-provider checkbox on submit AND save, defaulting OFF (869e9xq5y-fu1)', () => {
    const base = { type: 'submit', key: 'P-1', title: 't', description: 'd' };
    expect(parseTicketFormMessage({ ...base, createInProvider: true })).toMatchObject({
      type: 'submit',
      createInProvider: true,
    });
    // Absent / non-boolean reads as OFF — a stale page must never mint an
    // unrequested remote task.
    expect(parseTicketFormMessage(base)).toMatchObject({ createInProvider: false });
    expect(parseTicketFormMessage({ ...base, createInProvider: 'yes' })).toMatchObject({
      createInProvider: false,
    });
    expect(parseTicketFormMessage({ ...base, type: 'save', createInProvider: true })).toMatchObject({
      type: 'save',
      createInProvider: true,
    });
    expect(parseTicketFormMessage({ ...base, type: 'save' })).toMatchObject({
      type: 'save',
      createInProvider: false,
    });
  });

  it('accepts create-provider-ticket (the edit-mode button)', () => {
    expect(parseTicketFormMessage({ type: 'create-provider-ticket' })).toEqual({
      type: 'create-provider-ticket',
    });
  });

  it('accepts a well-formed set-agent message', () => {
    expect(parseTicketFormMessage({ type: 'set-agent', id: 'reviewer' })).toEqual({
      type: 'set-agent',
      id: 'reviewer',
    });
  });

  it('accepts set-type, including the empty "inherit" choice', () => {
    expect(parseTicketFormMessage({ type: 'set-type', id: 'fix' })).toEqual({
      type: 'set-type',
      id: 'fix',
    });
    expect(parseTicketFormMessage({ type: 'set-type', id: '' })).toEqual({
      type: 'set-type',
      id: '',
    });
    expect(parseTicketFormMessage({ type: 'set-type', id: 7 })).toBeNull();
  });

  it('accepts set-model, including the empty "inherit" choice', () => {
    expect(parseTicketFormMessage({ type: 'set-model', id: 'claude-sonnet-5' })).toEqual({
      type: 'set-model',
      id: 'claude-sonnet-5',
    });
    expect(parseTicketFormMessage({ type: 'set-model', id: '' })).toEqual({
      type: 'set-model',
      id: '',
    });
  });

  it('accepts set-provider, including the empty "inherit" choice', () => {
    expect(parseTicketFormMessage({ type: 'set-provider', id: 'codex' })).toEqual({
      type: 'set-provider',
      id: 'codex',
    });
    expect(parseTicketFormMessage({ type: 'set-provider', id: '' })).toEqual({
      type: 'set-provider',
      id: '',
    });
  });

  // The webview is a trust boundary: an unrecognized provider id must never
  // reach resolveAdapter's FACTORIES lookup (a TypeError there would crash
  // the openSession command handler before its own guards run).
  it('rejects a set-provider message with an unrecognized provider id', () => {
    expect(parseTicketFormMessage({ type: 'set-provider', id: 'evil' })).toBeNull();
  });

  it('degrades an unrecognized agentProvider on submit/save to null rather than rejecting the whole message', () => {
    expect(
      parseTicketFormMessage({
        type: 'submit', key: 'P-1', title: 't', description: 'd', agentProvider: 'evil', ticketType: null,
      }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null, createInProvider: false, pullBase: true,
    });
    expect(
      parseTicketFormMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', agentProvider: 'evil', ticketType: null,
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null, ticketType: null, createInProvider: false,
    });
  });

  // open-ticket-link drives vscode.env.openExternal, so the scheme allowlist is
  // the trust boundary — not the non-empty-string check this used to carry. The
  // dashboard guarded this and the ticket form didn't; both now share isHttpUrl.
  it('rejects a non-http(s) open-ticket-link url', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'command:foo', '']) {
      expect(parseTicketFormMessage({ type: 'open-ticket-link', url })).toBeNull();
    }
    expect(parseTicketFormMessage({ type: 'open-ticket-link' })).toBeNull();
    expect(parseTicketFormMessage({ type: 'open-ticket-link', url: 42 })).toBeNull();
  });

  it('rejects malformed shapes (trust boundary)', () => {
    expect(parseTicketFormMessage(null)).toBeNull();
    expect(parseTicketFormMessage({})).toBeNull();
    expect(parseTicketFormMessage({ type: 'unknown' })).toBeNull();
    expect(parseTicketFormMessage({ type: 'fetch-source' })).toBeNull(); // missing ref
    expect(parseTicketFormMessage({ type: 'save-signals', service: 'be' })).toBeNull(); // missing signals
    expect(
      parseTicketFormMessage({ type: 'save-signals', service: 'be', signals: [1, 2] }),
    ).toBeNull(); // non-string signals
    expect(parseTicketFormMessage({ type: 'set-repos', repos: 'fe' })).toBeNull(); // not an array
    expect(parseTicketFormMessage({ type: 'submit', title: 't' })).toBeNull(); // missing key
    expect(parseTicketFormMessage({ type: 'install-approach', id: 'rpi' })).toBeNull(); // removed message type
  });
});

describe('routeTicketFormAction', () => {
  function spyActions(): TicketFormActions {
    return {
      fetchSource: vi.fn(),
      searchTickets: vi.fn(),
      searchStatuses: vi.fn(),
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
      createProviderTicket: vi.fn(),
      submit: vi.fn(),
      save: vi.fn(),
      requestState: vi.fn(),
      closeForm: vi.fn(),
    };
  }

  it('routes each valid message to its action', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'fetch-source', ref: 'CU-1' }, actions);
    routeTicketFormAction({ type: 'search-tickets', query: 'pay', status: 'to do' }, actions);
    routeTicketFormAction({ type: 'search-statuses' }, actions);
    routeTicketFormAction({ type: 'save-signals', service: 'be', signals: ['api'] }, actions);
    routeTicketFormAction(
      { type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex' },
      actions,
    );
    routeTicketFormAction({ type: 'analyze', prompt: 'go' }, actions);
    routeTicketFormAction({ type: 'set-agent', id: 'reviewer' }, actions);
    routeTicketFormAction({ type: 'set-model', id: 'claude-sonnet-5' }, actions);
    routeTicketFormAction({ type: 'set-provider', id: 'antigravity' }, actions);
    routeTicketFormAction({ type: 'set-type', id: 'fix' }, actions);
    routeTicketFormAction({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' }, actions);
    routeTicketFormAction({ type: 'create-provider-ticket' }, actions);
    routeTicketFormAction({ type: 'close-form' }, actions);
    expect(actions.fetchSource).toHaveBeenCalledWith('CU-1');
    expect(actions.searchTickets).toHaveBeenCalledWith('pay', 'to do');
    expect(actions.searchStatuses).toHaveBeenCalled();
    expect(actions.saveSignals).toHaveBeenCalledWith('be', ['api']);
    expect(actions.submit).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null, createInProvider: false, pullBase: true,
    });
    expect(actions.analyze).toHaveBeenCalledWith('go');
    expect(actions.setAgent).toHaveBeenCalledWith('reviewer');
    expect(actions.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(actions.setProvider).toHaveBeenCalledWith('antigravity');
    expect(actions.setType).toHaveBeenCalledWith('fix');
    expect(actions.openTicketLink).toHaveBeenCalledWith('https://app.clickup.com/t/CU-1');
    expect(actions.createProviderTicket).toHaveBeenCalled();
    expect(actions.closeForm).toHaveBeenCalled();
    // set-provider must not also drive setType (a missing `return` in the
    // switch made a provider pick write the provider id as the ticket TYPE).
    expect(actions.setType).toHaveBeenCalledTimes(1);
  });

  it('routes a valid save message to the save action', () => {
    const actions = spyActions();
    routeTicketFormAction(
      { type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex' },
      actions,
    );
    expect(actions.save).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex', ticketType: null, createInProvider: false,
    });
  });

  it('does not fall through from set-provider into set-type', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'set-provider', id: 'codex' }, actions);
    expect(actions.setProvider).toHaveBeenCalledWith('codex');
    expect(actions.setType).not.toHaveBeenCalled();
  });

  it('ignores install-approach (removed — install now lives in settings)', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'install-approach', id: 'rpi' }, actions);
    expect(actions.analyze).not.toHaveBeenCalled();
  });

  it('ignores malformed messages without throwing', () => {
    const actions = spyActions();
    expect(() => routeTicketFormAction({ type: 'nope' }, actions)).not.toThrow();
    expect(actions.fetchSource).not.toHaveBeenCalled();
  });

  it('does not route a malformed search-tickets', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'search-tickets', query: 7, status: null }, actions);
    routeTicketFormAction({ type: 'search-tickets' }, actions);
    expect(actions.searchTickets).not.toHaveBeenCalled();
  });
});

describe('attachment messages', () => {
  function spyActions(): TicketFormActions {
    return {
      fetchSource: vi.fn(),
      searchTickets: vi.fn(),
      searchStatuses: vi.fn(),
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
      createProviderTicket: vi.fn(),
      submit: vi.fn(),
      save: vi.fn(),
      requestState: vi.fn(),
      closeForm: vi.fn(),
      attachPick: vi.fn(),
      attachBytes: vi.fn(),
      detachAttachment: vi.fn(),
      openAttachment: vi.fn(),
    };
  }

  it('routes attach-pick', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'attach-pick' }, actions);
    expect(actions.attachPick).toHaveBeenCalled();
  });

  it('routes a well-formed attach-bytes', () => {
    const actions = spyActions();
    routeTicketFormAction(
      { type: 'attach-bytes', name: 'shot.png', base64: 'AAAA' }, actions,
    );
    expect(actions.attachBytes).toHaveBeenCalledWith('shot.png', 'AAAA');
  });

  it('ignores attach-bytes with a non-string name or payload', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'attach-bytes', name: 1, base64: 'AAAA' }, actions);
    routeTicketFormAction({ type: 'attach-bytes', name: 'a.png', base64: null }, actions);
    routeTicketFormAction({ type: 'attach-bytes', name: 'a.png' }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  it('ignores attach-bytes with an empty name', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'attach-bytes', name: '', base64: 'AAAA' }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  it('ignores attach-bytes with an empty base64 payload', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'attach-bytes', name: 'a.png', base64: '' }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  // The webview caps this too. Re-checked here because argv from a webview is
  // never trusted on the grounds that the webview already checked it — the same
  // rule the CLI's stage/phase split exists for.
  it('ignores attach-bytes whose payload exceeds the paste cap', () => {
    const actions = spyActions();
    // 4 base64 chars per 3 bytes, so this decodes to just over the cap.
    const oversize = 'A'.repeat(Math.ceil((MAX_PASTE_BYTES + 1024) / 3) * 4);
    routeTicketFormAction({ type: 'attach-bytes', name: 'a.png', base64: oversize }, actions);
    expect(actions.attachBytes).not.toHaveBeenCalled();
  });

  it('uses decoded size when cap and cap-plus-one have the same encoded length', () => {
    const actions = spyActions();
    const atCap = Buffer.alloc(MAX_PASTE_BYTES).toString('base64');
    const overCap = Buffer.alloc(MAX_PASTE_BYTES + 1).toString('base64');
    expect(atCap).toHaveLength(overCap.length);

    routeTicketFormAction({ type: 'attach-bytes', name: 'edge.png', base64: atCap }, actions);
    routeTicketFormAction({ type: 'attach-bytes', name: 'over.png', base64: overCap }, actions);

    expect(actions.attachBytes).toHaveBeenCalledTimes(1);
    expect(actions.attachBytes).toHaveBeenCalledWith('edge.png', atCap);
  });

  it('routes detach-attachment and open-attachment with a numeric id', () => {
    const actions = spyActions();
    routeTicketFormAction({ type: 'detach-attachment', id: 7 }, actions);
    routeTicketFormAction({ type: 'open-attachment', id: 7 }, actions);
    expect(actions.detachAttachment).toHaveBeenCalledWith(7);
    expect(actions.openAttachment).toHaveBeenCalledWith(7);
  });

  it('returns each attachment action promise to the panel', () => {
    const actions = spyActions();
    const pick = Promise.resolve();
    const bytes = Promise.resolve();
    const detach = Promise.resolve();
    const open = Promise.resolve();
    actions.attachPick = vi.fn(() => pick);
    actions.attachBytes = vi.fn(() => bytes);
    actions.detachAttachment = vi.fn(() => detach);
    actions.openAttachment = vi.fn(() => open);

    expect(routeTicketFormAction({ type: 'attach-pick' }, actions)).toBe(pick);
    expect(
      routeTicketFormAction(
        { type: 'attach-bytes', name: 'shot.png', base64: 'AAAA' },
        actions,
      ),
    ).toBe(bytes);
    expect(routeTicketFormAction({ type: 'detach-attachment', id: 7 }, actions)).toBe(detach);
    expect(routeTicketFormAction({ type: 'open-attachment', id: 7 }, actions)).toBe(open);
  });

  it('ignores a detach/open whose id is not a positive integer', () => {
    const actions = spyActions();
    for (const id of ['7', 0, -1, 1.5, NaN, null, undefined]) {
      routeTicketFormAction({ type: 'detach-attachment', id }, actions);
      routeTicketFormAction({ type: 'open-attachment', id }, actions);
    }
    expect(actions.detachAttachment).not.toHaveBeenCalled();
    expect(actions.openAttachment).not.toHaveBeenCalled();
  });
});
