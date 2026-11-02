import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { transition } from '../machine.js';
import { openImplementationRun, openImplementationSegment } from '../../store/implementationRuns.js';
import { recordSessionLaunchIntent } from '../../store/sessionLaunchIntents.js';
import { openProcessRun } from '../../store/processRuns.js';
import { findLatestImplRun } from './shipStore.js';

describe('findLatestImplRun', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
  });
  afterEach(() => store.close());

  const openRun = (provider: string, model: string): number =>
    openImplementationRun(store, {
      ticketId, attempt: 0, provider, model, startedAt: '2026-08-01T10:00:00.000Z',
    }).id;

  const openSegment = (runId: number, launchId: string, provider: string, model: string | null): void => {
    const intent = recordSessionLaunchIntent(store, {
      ticketId, launchId, purpose: 'implementation', provider, model,
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    openImplementationSegment(store, {
      implementationRunId: runId, provider, model,
      launchIntentId: intent.id, startedAt: '2026-08-01T10:00:00.000Z',
    });
  };

  it('returns undefined when impl never ran', () => {
    expect(findLatestImplRun(store, ticketId)).toBeUndefined();
  });

  it('returns the session run provider and model', () => {
    openRun('claude', 'claude-sonnet-5-5');
    expect(findLatestImplRun(store, ticketId)).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('ignores a later guide-pull telemetry row on the impl stage', () => {
    openRun('claude', 'claude-sonnet-5-5');
    openProcessRun(store, {
      ticketId, stageKey: 'impl', processId: 'guide-pull', attempt: 0,
      provider: 'opencode2', startedAt: '2026-08-01T10:05:00.000Z',
    });
    expect(findLatestImplRun(store, ticketId)).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('prefers the latest implementation segment after a provider switch', () => {
    const runId = openRun('claude', 'claude-sonnet-5-5');
    openSegment(runId, 'l1', 'claude', 'claude-sonnet-5-5');
    openSegment(runId, 'l2', 'codex', 'gpt-5.5');
    expect(findLatestImplRun(store, ticketId)).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });
});
