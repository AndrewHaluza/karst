import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listInbox } from '../store/ticketMessages.js';
import { recordSessionLaunchIntent } from '../store/sessionLaunchIntents.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configuredSessionModel, recordModelSelectionWarning } from './modelSelection.js';

describe('model selection guard (T1005)', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  afterEach(() => store.close());

  /** Record a launch the way the host does: every launch (switch/resume too) writes one. */
  function launch(
    launchId: string,
    model: string | null,
    reason: 'initial' | 'switch' | 'resume' = 'initial',
  ): void {
    recordSessionLaunchIntent(store, {
      ticketId,
      launchId,
      purpose: 'implementation',
      provider: 'opencode2',
      model,
      reason,
      sessionOrigin: reason === 'resume' ? 'resume' : 'new',
      at: '2026-11-07T10:00:00.000Z',
    });
  }

  it('reads the configured model from the launch intent, pinned by launch id', () => {
    launch('L1', 'opencode-go/deepseek-v4.1-flash');
    expect(configuredSessionModel(store, ticketId, 'L1')).toBe('opencode-go/deepseek-v4.1-flash');
    // No launch id (a legacy channel): the newest intent is the fallback.
    expect(configuredSessionModel(store, ticketId)).toBe('opencode-go/deepseek-v4.1-flash');
  });

  it('warns on the ticket, naming both models, when the first step differs', () => {
    launch('L1', 'opencode-go/deepseek-v4.1-flash');
    expect(
      recordModelSelectionWarning(
        store,
        ticketId,
        {
          providerID: 'openrouter',
          modelID: 'anthropic/claude-haiku-5.5',
          variant: 'high',
        },
        'L1',
      ),
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
    launch('L1', 'opencode-go/deepseek-v4.1-flash');
    expect(
      recordModelSelectionWarning(
        store,
        ticketId,
        {
          providerID: 'opencode-go',
          modelID: 'deepseek-v4.1-flash',
        },
        'L1',
      ),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });

  // Review of T1005: `process_runs.model` is immutable after insert, so a live
  // switch leaves it naming the PREVIOUS model. The guard must read the switch
  // launch's own intent, or it warns about the model the user just chose.
  it('compares against the switched-to model, not the stale process run model', () => {
    launch('L1', 'opencode-go/deepseek-v4.1-flash');
    launch('L2', 'openrouter/anthropic/claude-haiku-5.5', 'switch');
    expect(
      recordModelSelectionWarning(
        store,
        ticketId,
        { providerID: 'openrouter', modelID: 'anthropic/claude-haiku-5.5' },
        'L2',
      ),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });

  // The other half of the same review finding: a newer still-running launch on
  // the ticket (e.g. a fix session) must not supply the expected model for the
  // implementation session that actually reported.
  it('pins the expected model to the reporting launch, not the newest one', () => {
    launch('L1', 'opencode-go/deepseek-v4.1-flash');
    launch('L2', 'openrouter/anthropic/claude-haiku-5.5', 'switch');
    expect(
      recordModelSelectionWarning(
        store,
        ticketId,
        { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
        'L1',
      ),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });

  it('falls back to the newest launch intent when the launch id is unknown', () => {
    launch('L1', 'opencode-go/deepseek-v4.1-flash');
    launch('L2', 'openrouter/anthropic/claude-haiku-5.5', 'switch');
    expect(configuredSessionModel(store, ticketId, 'unknown')).toBe(
      'openrouter/anthropic/claude-haiku-5.5',
    );
  });

  it('cannot compare when no launch recorded a model', () => {
    launch('L1', null);
    expect(
      recordModelSelectionWarning(
        store,
        ticketId,
        {
          providerID: 'openrouter',
          modelID: 'anthropic/claude-haiku-5.5',
        },
        'L1',
      ),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });

  it('compares a configured model that carries an effort suffix by model id only', () => {
    launch('L1', 'opencode-go/deepseek-v4.1-flash#high');
    expect(
      recordModelSelectionWarning(
        store,
        ticketId,
        {
          providerID: 'opencode-go',
          modelID: 'deepseek-v4.1-flash',
        },
        'L1',
      ),
    ).toBe(false);
    expect(listInbox(store, ticketId, { unreadOnly: false })).toEqual([]);
  });
});
