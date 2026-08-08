import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import {
  openImplementationRun,
  openImplementationSegment,
  confirmImplementationSegment,
  closeImplementationSegment,
  completeImplementationRun,
  interruptImplementationRun,
  listImplementationTimeline,
  summarizeSegmentTokens,
} from './implementationRuns.js';
import {
  recordSessionLaunchIntent,
  confirmSessionLaunchIntent,
} from './sessionLaunchIntents.js';
import { listProcessRuns } from './processRuns.js';

describe('implementation runs and segments', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    // Walk to impl (scope pass) — impl is an explicit-marker boundary.
    transition(store, ticketId, 'scope', { kind: 'passed' });
  });
  afterEach(() => store.close());

  it('opens a run with its canonical Session process run and attempt', () => {
    const run = openImplementationRun(store, {
      ticketId,
      attempt: 0,
      provider: 'claude',
      model: 'opus',
      startedAt: '2026-08-01T10:00:00.000Z',
    });

    expect(run.ticketId).toBe(ticketId);
    expect(run.status).toBe('running');
    expect(run.endedAt).toBeNull();
    const processRuns = listProcessRuns(store, ticketId);
    expect(processRuns).toHaveLength(1);
    expect(processRuns[0]!.id).toBe(run.processRunId);
    expect(processRuns[0]!.stageKey).toBe('impl');
    expect(processRuns[0]!.processId).toBe('session');
    expect(processRuns[0]!.provider).toBe('claude');
    expect(processRuns[0]!.model).toBe('opus');
    expect(processRuns[0]!.attempt).toBe(0);
  });

  it('an ordinary first launch creates the first segment without any switch intent', () => {
    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    expect(confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    })).toBe('confirmed');

    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.segments).toHaveLength(1);
    const segment = timeline.segments[0]!;
    expect([segment.provider, segment.model]).toEqual(['claude', 'opus']);
    expect(segment.reason).toBeNull();
    expect(segment.status).toBe('running');
    expect(segment.providerSessionId).toBe('claude-session-1');
    expect(segment.startedAt).toBe('2026-08-01T10:01:00.000Z');
  });

  it('preserves the stable run across a switch and attaches each provider session', () => {
    const initial = recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    const stableRunId = initial.implementationRunId!;
    confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    });

    const switched = recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l2', purpose: 'implementation', provider: 'codex', model: 'sol',
      reason: 'switch', sessionOrigin: 'new', at: '2026-08-01T10:02:00.000Z',
    });
    expect(switched.implementationRunId).toBe(stableRunId);
    expect(confirmSessionLaunchIntent(store, 'l2', {
      ticketId, provider: 'codex', providerSessionId: 'codex-session-2',
      at: '2026-08-01T10:03:00.000Z',
    })).toBe('confirmed');

    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.run.id).toBe(stableRunId);
    expect(timeline.segments.map((s) => [s.provider, s.model])).toEqual([
      ['claude', 'opus'],
      ['codex', 'sol'],
    ]);
    expect(timeline.segments[1]!.providerSessionId).toBe('codex-session-2');
    expect(timeline.segments[0]!.status).toBe('closed');
    expect(timeline.segments[0]!.endedAt).toBe('2026-08-01T10:03:00.000Z');
    expect(timeline.segments[1]!.status).toBe('running');
    // The provider session ids are per-core: the switch segment carries only its own.
    expect(timeline.segments[0]!.providerSessionId).toBe('claude-session-1');
  });

  it('an ordinary resume reattaches the provider session to the stable run', () => {
    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    });
    const before = listImplementationTimeline(store, ticketId)!;

    const resumed = recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l3', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', at: '2026-08-01T10:30:00.000Z',
    });
    expect(resumed.implementationRunId).toBe(before.run.id);
    expect(confirmSessionLaunchIntent(store, 'l3', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:31:00.000Z',
    })).toBe('confirmed');

    const after = listImplementationTimeline(store, ticketId)!;
    expect(after.run.id).toBe(before.run.id);
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0]!.status).toBe('running');
    expect(after.segments[0]!.providerSessionId).toBe('claude-session-1');
    expect(after.segments[0]!.launchIntentId).toBe(resumed.id);
  });

  it('reopens an interrupted run when a resume start arrives', () => {
    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    });
    // The session ended without the marker: the run is interrupted.
    expect(interruptImplementationRun(store, ticketId, '2026-08-01T10:20:00.000Z')).toBe(true);
    expect(listImplementationTimeline(store, ticketId)!.run.status).toBe('interrupted');

    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l4', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', at: '2026-08-01T10:30:00.000Z',
    });
    expect(confirmSessionLaunchIntent(store, 'l4', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:31:00.000Z',
    })).toBe('confirmed');

    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.run.status).toBe('running');
    expect(timeline.run.endedAt).toBeNull();
    expect(timeline.segments[0]!.status).toBe('running');
  });

  it('completeImplementationRun closes the segment and the Session process run and passes the run', () => {
    const run = openImplementationRun(store, {
      ticketId, attempt: 0, provider: 'claude', model: 'opus',
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    const intent = recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    const segment = openImplementationSegment(store, {
      implementationRunId: run.id, provider: 'claude', model: 'opus',
      launchIntentId: intent.id, startedAt: '2026-08-01T10:00:00.000Z',
    });
    confirmImplementationSegment(store, {
      segmentId: segment.id, providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    });

    completeImplementationRun(store, ticketId, '2026-08-01T11:00:00.000Z');

    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.run.status).toBe('passed');
    expect(timeline.run.endedAt).toBe('2026-08-01T11:00:00.000Z');
    expect(timeline.segments[0]!.status).toBe('closed');
    expect(timeline.segments[0]!.endedAt).toBe('2026-08-01T11:00:00.000Z');
    const processRuns = listProcessRuns(store, ticketId);
    expect(processRuns[0]!.status).toBe('passed');
    expect(processRuns[0]!.endedAt).toBe('2026-08-01T11:00:00.000Z');
  });

  it('completeImplementationRun is a no-op when no run is running', () => {
    expect(() => completeImplementationRun(store, ticketId, '2026-08-01T11:00:00.000Z')).not.toThrow();
    expect(listImplementationTimeline(store, ticketId)).toBeNull();
  });

  it('interruptImplementationRun interrupts the run, its segment and its process run — never a pass', () => {
    recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    confirmSessionLaunchIntent(store, 'l1', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1',
      at: '2026-08-01T10:01:00.000Z',
    });

    expect(interruptImplementationRun(store, ticketId, '2026-08-01T10:20:00.000Z')).toBe(true);
    const timeline = listImplementationTimeline(store, ticketId)!;
    expect(timeline.run.status).toBe('interrupted');
    expect(timeline.run.endedAt).toBe('2026-08-01T10:20:00.000Z');
    expect(timeline.segments[0]!.status).toBe('interrupted');
    expect(timeline.segments[0]!.endedAt).toBe('2026-08-01T10:20:00.000Z');
    const processRuns = listProcessRuns(store, ticketId);
    expect(processRuns[0]!.status).toBe('interrupted');
    expect(processRuns[0]!.endedAt).toBe('2026-08-01T10:20:00.000Z');
  });

  it('interruptImplementationRun is a no-op for a run that already passed', () => {
    const run = openImplementationRun(store, {
      ticketId, attempt: 0, provider: 'claude', model: 'opus',
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    completeImplementationRun(store, ticketId, '2026-08-01T11:00:00.000Z');
    expect(interruptImplementationRun(store, ticketId, '2026-08-01T11:10:00.000Z')).toBe(false);
    expect(listImplementationTimeline(store, ticketId)!.run.status).toBe('passed');
    expect(listImplementationTimeline(store, ticketId)!.run.endedAt).toBe('2026-08-01T11:00:00.000Z');
    expect(run.processRunId).toBeDefined();
  });

  it('open/confirm/close segments transitions through the closed vocabulary', () => {
    const run = openImplementationRun(store, {
      ticketId, attempt: 0, provider: 'claude', model: 'opus',
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    const intent = recordSessionLaunchIntent(store, {
      ticketId, launchId: 'l1', purpose: 'implementation', provider: 'claude', model: 'opus',
      reason: 'initial', sessionOrigin: 'new', at: '2026-08-01T10:00:00.000Z',
    });
    const segment = openImplementationSegment(store, {
      implementationRunId: run.id, provider: 'claude', model: 'opus',
      launchIntentId: intent.id, startedAt: '2026-08-01T10:00:00.000Z',
    });
    expect(segment.status).toBe('pending');

    expect(confirmImplementationSegment(store, {
      segmentId: segment.id, providerSessionId: 'sess-9', at: '2026-08-01T10:01:00.000Z',
    })).toBe(true);
    expect(listImplementationTimeline(store, ticketId)!.segments[0]!.status).toBe('running');

    // Confirming twice is a no-op — a segment confirms exactly once.
    expect(confirmImplementationSegment(store, {
      segmentId: segment.id, providerSessionId: 'sess-9', at: '2026-08-01T10:02:00.000Z',
    })).toBe(false);

    expect(closeImplementationSegment(store, segment.id, '2026-08-01T11:00:00.000Z')).toBe(true);
    const closed = listImplementationTimeline(store, ticketId)!.segments[0]!;
    expect(closed.status).toBe('closed');
    expect(closed.endedAt).toBe('2026-08-01T11:00:00.000Z');
    expect(closeImplementationSegment(store, segment.id, '2026-08-01T11:05:00.000Z')).toBe(false);
  });

  it('returns nothing for a ticket that never opened an implementation run', () => {
    expect(listImplementationTimeline(store, ticketId)).toBeNull();
  });

  it('a segment without measured usage omits tokens rather than reporting total 0', () => {
    expect(summarizeSegmentTokens([])).toBeNull();
  });

  it('summarizes measured rows into one segment total', () => {
    const summary = summarizeSegmentTokens([
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
        totalTokens: 150, estimated: 0, outcome: 'ok' },
      { inputTokens: 200, outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 0,
        totalTokens: 310, estimated: 1, outcome: 'error' },
    ]);
    expect(summary).toEqual({
      calls: 2,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      totalTokens: 460,
      estimatedCalls: 1,
      erroredCalls: 1,
    });
  });
});
