import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { markImplementDone } from './implement.js';
import { transition } from '../machine.js';
import {
  recordSessionLaunchIntent,
  confirmSessionLaunchIntent,
} from '../../store/sessionLaunchIntents.js';
import {
  listImplementationTimeline,
} from '../../store/implementationRuns.js';
import { listProcessRuns } from '../../store/processRuns.js';

describe('markImplementDone', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    // walk to impl (scope pass) — impl is an explicit-marker boundary.
    transition(store, ticketId, 'scope', { kind: 'passed' });
  });
  afterEach(() => store.close());

  function openConfirmedRun(): void {
    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'launch-1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    confirmSessionLaunchIntent(store, 'launch-1', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    });
  }

  it('transitions impl -> uat via an explicit marker (never a Stop hook)', () => {
    const next = markImplementDone(store, ticketId);
    expect(next).toBe('uat');
    expect(getTicket(store, ticketId).stageCurrent).toBe('uat');
  });

  it('closes the active segment and its Session process run, marks the run passed, and advances to UAT', () => {
    openConfirmedRun();
    const timeline = listImplementationTimeline(store, ticketId)!;

    const next = markImplementDone(store, ticketId);

    expect(next).toBe('uat');
    const after = listImplementationTimeline(store, ticketId)!;
    expect(after.run.id).toBe(timeline.run.id);
    expect(after.run.status).toBe('passed');
    expect(after.run.endedAt).not.toBeNull();
    expect(after.segments[0]!.status).toBe('closed');
    expect(after.segments[0]!.endedAt).not.toBeNull();
    const processRuns = listProcessRuns(store, ticketId);
    expect(processRuns[0]!.status).toBe('passed');
    expect(processRuns[0]!.endedAt).not.toBeNull();
  });

  it('a stale marker changes nothing — the run, the segment and the process run stay as they were', () => {
    openConfirmedRun();
    markImplementDone(store, ticketId);
    const passed = listImplementationTimeline(store, ticketId)!;

    // The ticket already left impl; a second (stale) marker must be refused.
    expect(() => markImplementDone(store, ticketId)).toThrow(/current stage/);

    const after = listImplementationTimeline(store, ticketId)!;
    expect(after.run).toEqual(passed.run);
    expect(after.segments).toEqual(passed.segments);
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('passed');
  });

  it('completes a run that has no confirmed segment (marker without a live session)', () => {
    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'launch-1', purpose: 'implementation',
      provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
      at: '2026-08-01T10:00:00.000Z',
    });
    expect(listImplementationTimeline(store, ticketId)!.segments).toHaveLength(0);

    expect(markImplementDone(store, ticketId)).toBe('uat');
    const after = listImplementationTimeline(store, ticketId)!;
    expect(after.run.status).toBe('passed');
    expect(after.run.endedAt).not.toBeNull();
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('passed');
  });
});
