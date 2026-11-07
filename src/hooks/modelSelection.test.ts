import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listInbox } from '../store/ticketMessages.js';
import { openProcessRun } from '../store/processRuns.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordModelSelectionWarning, runningSessionModel } from './modelSelection.js';

describe('model selection guard (T1005)', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  afterEach(() => store.close());

  function openSession(model: string | null, processId = 'session'): void {
    openProcessRun(store, {
      ticketId,
      stageKey: 'impl',
      processId,
      attempt: 1,
      provider: 'opencode2',
      model,
      startedAt: '2026-11-07T10:00:00.000Z',
    });
  }

  it('reads the configured model from the running session run', () => {
    openSession('opencode-go/deepseek-v4.1-flash');
    expect(runningSessionModel(store, ticketId)).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('warns on the ticket, naming both models, when the first step differs', () => {
    openSession('opencode-go/deepseek-v4.1-flash');
    expect(
      recordModelSelectionWarning(store, ticketId, {
        providerID: 'openrouter',
        modelID: 'anthropic/claude-haiku-5.5',
        variant: 'high',
      }),
    ).toBe(true);
    const inbox = listInbox(store, ticketId, { unreadOnly: false });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind).toBe('event');
    expect(inbox[0]!.fromTicketId).toBeNull();
    expect(inbox[0]!.body).toContain('openrouter/anthropic/claude-haiku-5.5');
    expect(inbox[0]!.body).toContain('opencode-go/deepseek-v4.1-flash');
    expect(inbox[0]!.body).toMatch(/warning/i);
  });

  it('does not warn when the first step matches the configured model', () => {
    openSession('opencode-go/deepseek-v4.1-flash');
    expect(
      recordModelSelectionWarning(store, ticketId, {
        providerID: 'opencode-go',
        modelID: 'deepseek-v4.1-flash',
      }),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });

  it('cannot compare when no running run recorded a model', () => {
    openSession(null);
    expect(
      recordModelSelectionWarning(store, ticketId, {
        providerID: 'openrouter',
        modelID: 'anthropic/claude-haiku-5.5',
      }),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });

  it('compares a configured model that carries an effort suffix by model id only', () => {
    openSession('opencode-go/deepseek-v4.1-flash#high');
    expect(
      recordModelSelectionWarning(store, ticketId, {
        providerID: 'opencode-go',
        modelID: 'deepseek-v4.1-flash',
      }),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });
});
