import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Store } from '../store/db.js';

const m = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  makeActions: vi.fn(),
  runOffer: vi.fn(),
  record: vi.fn(),
  once: vi.fn(),
  quotaFromHook: vi.fn(),
  trailing: vi.fn(),
  getTicket: vi.fn(),
}));
vi.mock('vscode', () => ({
  commands: { executeCommand: m.executeCommand },
  window: { showWarningMessage: m.showWarningMessage, showErrorMessage: m.showErrorMessage },
}));
vi.mock('./ops/interactiveUsageLimitActions.js', () => ({
  makeInteractiveParkActions: m.makeActions,
  runInteractiveOffer: m.runOffer,
}));
vi.mock('./ops/interactiveUsageLimitOps.js', () => ({
  recordInteractiveUsageLimit: m.record,
  makeOncePerError: () => m.once,
}));
vi.mock('../agent/interactiveQuota.js', () => ({ quotaTextFromHook: m.quotaFromHook, claudeTrailingQuota: m.trailing }));
vi.mock('../store/tickets.js', () => ({ getTicket: m.getTicket }));

import { createInteractiveUsageLimitBinding } from './interactiveUsageLimitBinding.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createInteractiveUsageLimitBinding', () => {
  const deps = {
    store: {} as Store,
    pick: vi.fn(),
    switchSession: vi.fn(),
    disposeSession: vi.fn(),
    sessionProviderFor: vi.fn(),
    refresh: vi.fn(),
  };
  const actions = { tag: 'actions' };
  beforeEach(() => {
    vi.clearAllMocks();
    m.makeActions.mockReturnValue(actions);
    m.getTicket.mockReturnValue({ key: 'T-9', model: 'opus', stageCurrent: 'impl' });
    m.runOffer.mockResolvedValue(undefined);
    deps.sessionProviderFor.mockReturnValue('claude');
  });

  it('wires the park actions with a relaunch that disposes then reopens the session', async () => {
    createInteractiveUsageLimitBinding(deps);
    const a = m.makeActions.mock.calls[0]![0];
    expect(a.store).toBe(deps.store);
    expect(a.pick).toBe(deps.pick);
    expect(a.switchSession).toBe(deps.switchSession);
    await a.relaunch(4);
    expect(deps.disposeSession).toHaveBeenCalledWith(4);
    expect(m.executeCommand).toHaveBeenCalledWith('karst.openSession', 4, { allowResume: true, providerReady: true });
  });

  it('reports a session error only when the hook carries quota text', () => {
    const b = createInteractiveUsageLimitBinding(deps);
    m.quotaFromHook.mockReturnValueOnce('');
    b.onSessionError(1, { session_id: 's1' } as never);
    expect(m.record).not.toHaveBeenCalled();
    m.quotaFromHook.mockReturnValueOnce('limit hit');
    b.onSessionError(1, { session_id: 's1' } as never);
    expect(m.record.mock.calls[0]![1]).toMatchObject({ ticketId: 1, sessionId: 's1', text: 'limit hit', provider: 'claude' });
    m.quotaFromHook.mockReturnValueOnce('again');
    b.onSessionError(1, {} as never);
    expect(m.record.mock.calls[1]![1].sessionId).toBe('unknown');
  });

  it('reports a Claude transcript once per error and forces the claude provider', () => {
    const b = createInteractiveUsageLimitBinding(deps);
    m.trailing.mockReturnValue(null);
    b.onClaudeTranscript(1, 's', 'x');
    m.trailing.mockReturnValue({ key: 'k', text: 'q' });
    m.once.mockReturnValueOnce(false);
    b.onClaudeTranscript(1, 's', 'x');
    expect(m.record).not.toHaveBeenCalled();
    m.once.mockReturnValueOnce(true);
    deps.sessionProviderFor.mockReturnValue('codex');
    b.onClaudeTranscript(2, 's2', 'x');
    expect(m.once).toHaveBeenLastCalledWith(2, 's2', 'k');
    expect(m.record.mock.calls[0]![1]).toMatchObject({ ticketId: 2, sessionId: 's2', provider: 'claude', text: 'q' });
  });

  it('skips the report when no provider is known', () => {
    const b = createInteractiveUsageLimitBinding(deps);
    deps.sessionProviderFor.mockReturnValue(null);
    b.report(1, 's', 't');
    expect(m.record).not.toHaveBeenCalled();
  });

  it('records the ticket model and stage, with null fallbacks', () => {
    const b = createInteractiveUsageLimitBinding(deps);
    b.report(1, 's', 't');
    expect(m.record.mock.calls[0]![1]).toEqual({ ticketId: 1, sessionId: 's', provider: 'claude', model: 'opus', stage: 'impl', text: 't' });
    m.getTicket.mockReturnValue({ key: 'T-9', model: '', stageCurrent: undefined });
    b.report(1, 's', 't');
    expect(m.record.mock.calls[1]![1]).toMatchObject({ model: null, stage: null });
  });

  it('offers: refreshes, asks with the provider label, and refreshes after', async () => {
    const b = createInteractiveUsageLimitBinding(deps);
    b.report(7, 's', 't');
    const offer = m.record.mock.calls[0]![0].offer as (id: number) => void;
    offer(55);
    expect(deps.refresh).toHaveBeenCalledWith(7);
    const input = m.runOffer.mock.calls[0]![0];
    expect(input).toMatchObject({ store: deps.store, ticketId: 7, parkId: 55, actions });
    m.showWarningMessage.mockResolvedValue('Retry');
    expect(await input.ask(['Retry', 'Switch'])).toBe('Retry');
    expect(m.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/^T-9: .+ hit its usage limit\.$/), 'Retry', 'Switch');
    await flush();
    expect(deps.refresh).toHaveBeenCalledTimes(2);
  });

  it('shows an error when the offer rejects, and still refreshes', async () => {
    const b = createInteractiveUsageLimitBinding(deps);
    b.report(7, 's', 't');
    m.runOffer.mockRejectedValueOnce(new Error('boom'));
    m.record.mock.calls[0]![0].offer(1);
    await flush();
    expect(m.showErrorMessage).toHaveBeenCalledWith('T-9: usage-limit action failed: boom');
    m.runOffer.mockRejectedValueOnce('plain');
    m.record.mock.calls[0]![0].offer(1);
    await flush();
    expect(m.showErrorMessage).toHaveBeenLastCalledWith('T-9: usage-limit action failed: plain');
    expect(deps.refresh).toHaveBeenCalledTimes(4);
  });
});
