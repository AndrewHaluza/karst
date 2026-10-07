import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import {
  openRecoveryRound,
  beginLiveFixExecution,
  listRecoveryRounds,
  FIX_PARKED_STALLED,
  FIX_PARKED_LAUNCH_NEVER_STARTED,
  recordFixLaunchIntent,
} from '../../store/recoveryRounds.js';
import {
  confirmSessionLaunchIntent,
  failSessionLaunchIntent,
  getSessionLaunchIntent,
  recordSessionLaunchIntent,
  supersedePendingLaunchIntents,
} from '../../store/sessionLaunchIntents.js';
import { getTicket, pauseTicket, setAgentState, archiveTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { listProcessRuns } from '../../store/processRuns.js';
import { attentionItems } from '../../ui/attention.js';
import {
  manifest as manifestFixture,
  uat as uatFixture,
  review as reviewFixture,
} from '../../manifest/fixtures.js';
import {
  runFixWatchdog,
  stallTimeoutMinutes,
  startFixWatchdog,
  sessionDelivery,
  redeliveryPrompt,
  FIX_WATCHDOG_INTERVAL_MS,
  DELIVERY_CHECK_MS,
  type FixWatchdogDeps,
} from './fixWatchdog.js';

const T0 = '2026-08-01T10:00:00.000Z';
const T2 = '2026-08-01T12:00:00.000Z';

/** The delivery window, comfortably past the 90s threshold. */
const AFTER_DELIVERY = new Date(Date.parse(T0) + DELIVERY_CHECK_MS + 60_000).toISOString();
/** One watchdog tick past a re-delivery. */
const NEXT_TICK = new Date(Date.parse(AFTER_DELIVERY) + FIX_WATCHDOG_INTERVAL_MS).toISOString();

describe('fixWatchdog', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'watchdog-proj' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' }); // -> impl
  });
  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  /** A ticket parked at fix, its fix stage row stamped at T0. */
  function toFix(ticket: number): void {
    transition(store, ticket, 'impl', { kind: 'passed' }); // -> uat
    transition(store, ticket, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    store.db
      .prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'")
      .run(T0, ticket);
  }

  /** A committed, still-pending recovery round for a fix ticket. */
  function pendingRound(ticket: number): number {
    return openRecoveryRound(store, {
      ticketId: ticket,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    }).id;
  }

  function stalledFix(ticket: number): number {
    const r = openRecoveryRound(store, {
      ticketId: ticket,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    });
    beginLiveFixExecution(store, { ticketId: ticket, roundId: r.id, startedAt: T0 });
    return r.id;
  }

  function implIntent(ticket: number, launchId = 'L-1', at = T0, provider = 'claude'): string {
    recordSessionLaunchIntent(store, {
      ticketId: ticket,
      launchId,
      purpose: 'implementation',
      provider,
      reason: 'initial',
      sessionOrigin: 'new',
      at,
    });
    return launchId;
  }

  /** A deps object with the park-only defaults plus overridable delivery seams. */
  function deps(over: Partial<FixWatchdogDeps> = {}): FixWatchdogDeps {
    return {
      store,
      timeoutMinutes: () => 60,
      projectId: () => projectId,
      now: () => T2,
      log: vi.fn(),
      isLive: () => true,
      nudge: vi.fn(() => true),
      isGraphTicket: () => false,
      ...over,
    };
  }

  it('parks a stalled round and logs it once', () => {
    toFix(ticketId);
    stalledFix(ticketId);
    const logged: string[] = [];

    const settled = runFixWatchdog(deps({ log: (m) => logged.push(m) }));

    expect(settled).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('showed no progress');
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('stale');
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.verdict).toBe(
      FIX_PARKED_STALLED,
    );
  });

  it('parks a fix whose launch never confirmed', () => {
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'L-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const log = vi.fn();

    const settled = runFixWatchdog(deps({ log }));

    expect(settled).toBe(1);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.verdict).toBe(
      FIX_PARKED_LAUNCH_NEVER_STARTED,
    );
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    expect(log.mock.calls.some((c) => String(c[0]).includes('never started'))).toBe(true);
  });

  it('one tick settles both a stalled run and an abandoned launch', () => {
    toFix(ticketId);
    stalledFix(ticketId);

    const other = createTicketFlow(store, { key: 'T-2', title: 't2', projectId }).id;
    transition(store, other, 'scope', { kind: 'passed' }); // -> impl
    toFix(other);
    const otherRound = pendingRound(other);
    recordFixLaunchIntent(store, {
      ticketId: other,
      launchId: 'L-2',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: otherRound,
      at: T0,
    });

    const log = vi.fn();
    const settled = runFixWatchdog(deps({ log }));

    expect(settled).toBe(2);
    expect(log.mock.calls.filter((c) => String(c[0]).includes('never started'))).toHaveLength(1);
  });

  it('returns 0 and sweeps nothing for a non-finite or non-positive timeout', () => {
    toFix(ticketId);
    stalledFix(ticketId);
    // A stale pending launch would be re-delivered/flagged if the guard ran.
    implIntent(ticketId, 'YOUNG-1');
    const nudge = vi.fn(() => true);
    const log = vi.fn();

    for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(runFixWatchdog(deps({ timeoutMinutes: () => minutes, nudge, log }))).toBe(0);
    }

    expect(nudge).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
  });

  it('logs nothing and returns 0 when there is nothing to settle', () => {
    const log = vi.fn();
    expect(runFixWatchdog(deps({ log }))).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('stallTimeoutMinutes takes the larger configured gate, defaulting when absent', () => {
    expect(stallTimeoutMinutes(undefined)).toBe(60);
    expect(stallTimeoutMinutes(manifestFixture({}))).toBe(60);
    expect(
      stallTimeoutMinutes(
        manifestFixture(
          {},
          {
            uat: uatFixture({ stallTimeoutMinutes: 30 }),
            review: reviewFixture({ stallTimeoutMinutes: 90 }),
          },
        ),
      ),
    ).toBe(90);
    expect(
      stallTimeoutMinutes(manifestFixture({}, { uat: uatFixture({ stallTimeoutMinutes: 120 }) })),
    ).toBe(120);
    // A non-positive or non-numeric value is filtered out, never the window.
    expect(
      stallTimeoutMinutes(
        manifestFixture({}, { uat: uatFixture({ stallTimeoutMinutes: 0 }) }),
      ),
    ).toBe(60);
    expect(
      stallTimeoutMinutes(
        manifestFixture({}, {
          uat: uatFixture({ stallTimeoutMinutes: '999' as unknown as number }),
        }),
      ),
    ).toBe(60);
  });

  it('settles this project immediately on start, then on the interval, until disposed', () => {
    vi.useFakeTimers();
    // A FUTURE fixed clock: stage rows are seeded at the real 'now', so a fake
    // clock in the past would stamp an ended_at earlier than a started_at.
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    toFix(ticketId);
    stalledFix(ticketId);
    const log = vi.fn();
    const m = manifestFixture(
      {},
      {
        uat: uatFixture({ stallTimeoutMinutes: 1 }),
        review: reviewFixture({ stallTimeoutMinutes: 1 }),
      },
    );
    const watchdog = startFixWatchdog(store, () => m, () => projectId, log, undefined, {
      isLive: () => false,
      nudge: () => false,
      isGraphTicket: () => false,
    });

    // The activation tick settles the stall with no interval elapsed.
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    expect(log).toHaveBeenCalledTimes(1);

    watchdog.dispose();
    const other = createTicketFlow(store, { key: 'T-2', title: 't2', projectId }).id;
    transition(store, other, 'scope', { kind: 'passed' }); // -> impl
    toFix(other);
    stalledFix(other);
    vi.advanceTimersByTime(FIX_WATCHDOG_INTERVAL_MS * 3);
    expect(listRecoveryRounds(store, other)[0]!.status).toBe('fixing');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reports a failed tick instead of swallowing it', () => {
    const onError = vi.fn();
    const watchdog = startFixWatchdog(
      store,
      () => {
        throw new Error('manifest boom');
      },
      () => projectId,
      () => {},
      onError,
      { isLive: () => false, nudge: () => false, isGraphTicket: () => false },
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain('watchdog tick failed');
    watchdog.dispose();
  });

  // ---------------------------------------------------------------------------
  // Launch-delivery guard (v68)
  // ---------------------------------------------------------------------------

  it('re-delivers a pending, live, old launch once and stamps redelivered_at', () => {
    const launchId = implIntent(ticketId);
    const nudge = vi.fn((_id: number, _prompt: string) => true);
    const log = vi.fn();

    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY, log }));

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge.mock.calls[0]![0]).toBe(ticketId);
    expect(String(nudge.mock.calls[0]![1])).toContain('launch brief did not reach you');
    expect(getSessionLaunchIntent(store, launchId)!.redeliveredAt).toBe(AFTER_DELIVERY);
    expect(log.mock.calls.some((c) => String(c[0]).includes('re-delivered'))).toBe(true);
  });

  it('covers an implementation-purpose intent (not just fix)', () => {
    const launchId = implIntent(ticketId, 'IMPL-1');
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getSessionLaunchIntent(store, launchId)!.redeliveredAt).not.toBeNull();
  });

  it('exempts a core with no SessionStart path (opencode2): never nudged, never flagged', () => {
    // opencode2 has no hook bridge yet, so its prepared launch can never confirm
    // — the guard must not read that as a lost brief.
    const launchId = implIntent(ticketId, 'OC2-1', T0, 'opencode2');
    const nudge = vi.fn(() => true);
    const log = vi.fn();
    runFixWatchdog(deps({ nudge, isLive: () => true, now: () => AFTER_DELIVERY, log }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getSessionLaunchIntent(store, launchId)!.redeliveredAt).toBeNull();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
    // Even with no live session it is not accused.
    runFixWatchdog(deps({ nudge, isLive: () => false, now: () => NEXT_TICK, log }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
    expect(log).not.toHaveBeenCalled();
  });

  it('re-delivers a fix-purpose intent with the fix brief', () => {
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'FIX-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getSessionLaunchIntent(store, 'FIX-1')!.redeliveredAt).not.toBeNull();
  });

  it('does nothing for a confirmed intent', () => {
    const launchId = implIntent(ticketId);
    confirmSessionLaunchIntent(store, launchId, {
      ticketId,
      provider: 'claude',
      providerSessionId: 'ses_1',
      at: T0,
    });
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
  });

  it('does nothing for an intent younger than the delivery window', () => {
    implIntent(ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({
      nudge,
      now: () => new Date(Date.parse(T0) + DELIVERY_CHECK_MS - 1_000).toISOString(),
    }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
  });

  it('marks needs-you without nudging when there is no live session', () => {
    implIntent(ticketId);
    const nudge = vi.fn(() => true);
    const log = vi.fn();
    runFixWatchdog(deps({ nudge, isLive: () => false, now: () => AFTER_DELIVERY, log }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).toBe('not-started');
    expect(log.mock.calls.some((c) => String(c[0]).includes('session did not start'))).toBe(true);
  });

  it('marks needs-you when the nudge does not reach the session', () => {
    implIntent(ticketId);
    const nudge = vi.fn(() => false);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getTicket(store, ticketId).agentState).toBe('not-started');
  });

  it('never nudges twice: a second tick marks needs-you instead', () => {
    implIntent(ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');

    runFixWatchdog(deps({ nudge, now: () => NEXT_TICK }));
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getTicket(store, ticketId).agentState).toBe('not-started');
  });

  it('reports "session did not start" as the attention reason', () => {
    implIntent(ticketId);
    runFixWatchdog(deps({ isLive: () => false, now: () => AFTER_DELIVERY }));
    const items = attentionItems([getTicket(store, ticketId)]);
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toBe('session did not start');
    expect(items[0]!.kind).toBe('input');
  });

  it('flags needs-you once and never re-logs or re-applies it on later ticks', () => {
    implIntent(ticketId);
    const log = vi.fn();
    const notStarted = (): number =>
      log.mock.calls.filter((c) => String(c[0]).includes('session did not start')).length;
    runFixWatchdog(deps({ isLive: () => false, now: () => AFTER_DELIVERY, log }));
    expect(notStarted()).toBe(1);
    runFixWatchdog(deps({ isLive: () => false, now: () => NEXT_TICK, log }));
    runFixWatchdog(deps({ isLive: () => false, now: () => NEXT_TICK, log }));
    expect(notStarted()).toBe(1);
    expect(getTicket(store, ticketId).agentState).toBe('not-started');
  });

  it('never overwrites a running session with needs-you', () => {
    implIntent(ticketId);
    setAgentState(store, ticketId, 'running');
    const log = vi.fn();
    runFixWatchdog(deps({ isLive: () => false, now: () => AFTER_DELIVERY, log }));
    // A later hook proved the session is alive even though the launch intent
    // never confirmed; the guard must not flip it amber.
    expect(getTicket(store, ticketId).agentState).toBe('running');
    expect(log).not.toHaveBeenCalled();
  });

  it('never overwrites a waiting session (a live question) with needs-you', () => {
    implIntent(ticketId);
    setAgentState(store, ticketId, 'waiting');
    const log = vi.fn();
    runFixWatchdog(deps({ isLive: () => false, now: () => AFTER_DELIVERY, log }));
    // Overwriting `waiting` would erase the question's reason AND lift the
    // done-marker refusal that protects a live waiting agent.
    expect(getTicket(store, ticketId).agentState).toBe('waiting');
    expect(log).not.toHaveBeenCalled();
  });

  it('never overwrites an idle session with needs-you', () => {
    implIntent(ticketId);
    setAgentState(store, ticketId, 'idle');
    runFixWatchdog(deps({ isLive: () => false, now: () => AFTER_DELIVERY }));
    expect(getTicket(store, ticketId).agentState).toBe('idle');
  });

  it('never nudges a session a hook already showed alive', () => {
    // SessionStart was dropped but a later hook arrived: the agent is alive and
    // already has the brief, so a re-delivery would duplicate the brief (and its
    // done-marker instruction) into a working or waiting agent.
    const launchId = implIntent(ticketId);
    const nudge = vi.fn(() => true);
    for (const state of ['running', 'waiting', 'idle'] as const) {
      setAgentState(store, ticketId, state);
      runFixWatchdog(deps({ nudge, isLive: () => true, now: () => AFTER_DELIVERY }));
      expect(getTicket(store, ticketId).agentState).toBe(state);
    }
    expect(nudge).not.toHaveBeenCalled();
    expect(getSessionLaunchIntent(store, launchId)!.redeliveredAt).toBeNull();
  });

  it('never overwrites a live state once every intent was already re-delivered', () => {
    // Tick 1 re-delivers and stamps the intent. A hook then proves the session
    // alive while the intent stays pending; tick 2 must not flip it to needs-you.
    const launchId = implIntent(ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, isLive: () => true, now: () => AFTER_DELIVERY }));
    expect(nudge).toHaveBeenCalledTimes(1);
    setAgentState(store, ticketId, 'running');
    runFixWatchdog(deps({ nudge, isLive: () => false, now: () => NEXT_TICK }));
    expect(getTicket(store, ticketId).agentState).toBe('running');
    expect(getSessionLaunchIntent(store, launchId)!.status).toBe('pending');
  });

  it('never touches a ticket that already advanced past impl/fix', () => {
    implIntent(ticketId);
    transition(store, ticketId, 'impl', { kind: 'passed' }); // -> uat
    transition(store, ticketId, 'uat', { kind: 'passed' }); // -> review
    transition(store, ticketId, 'review', { kind: 'passed' }); // -> ship
    transition(store, ticketId, 'ship', { kind: 'passed' }); // -> done
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
  });

  it('clears the guard flag when the ticket advances past impl/fix, so a shipped ticket is not "Needs you"', () => {
    implIntent(ticketId);
    runFixWatchdog(deps({ isLive: () => false, now: () => AFTER_DELIVERY }));
    expect(getTicket(store, ticketId).agentState).toBe('not-started');
    expect(attentionItems([getTicket(store, ticketId)])).toHaveLength(1);

    transition(store, ticketId, 'impl', { kind: 'passed' }); // -> uat
    expect(getTicket(store, ticketId).agentState).toBe('none');
    transition(store, ticketId, 'uat', { kind: 'passed' }); // -> review
    transition(store, ticketId, 'review', { kind: 'passed' }); // -> ship
    transition(store, ticketId, 'ship', { kind: 'passed' }); // -> done
    expect(attentionItems([getTicket(store, ticketId)])).toHaveLength(0);
  });

  it('re-delivers a fix launch exactly at the stall boundary (parking is strictly older)', () => {
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'EDGE-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const nudge = vi.fn(() => true);
    const settled = runFixWatchdog(
      deps({ nudge, timeoutMinutes: () => 60, now: () => new Date(Date.parse(T0) + 60 * 60_000).toISOString() }),
    );
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(settled).toBe(0);
  });

  it('does not nudge a fix launch the park sweep parks in the same tick', () => {
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'STALL-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const nudge = vi.fn(() => true);
    const settled = runFixWatchdog(
      deps({ nudge, timeoutMinutes: () => 1, now: () => new Date(Date.parse(T0) + 7 * 60_000).toISOString() }),
    );
    expect(nudge).not.toHaveBeenCalled();
    expect(settled).toBe(1);
    expect(getSessionLaunchIntent(store, 'STALL-1')!.status).toBe('failed');
  });

  it('still re-delivers an implementation launch older than the stall window', () => {
    implIntent(ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(
      deps({ nudge, timeoutMinutes: () => 1, now: () => new Date(Date.parse(T0) + 7 * 60_000).toISOString() }),
    );
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('skips a paused ticket', () => {
    implIntent(ticketId);
    pauseTicket(store, ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
  });

  it('skips a graph-owned ticket', () => {
    implIntent(ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, isGraphTicket: () => true, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
  });

  it('skips a failed or superseded intent', () => {
    implIntent(ticketId, 'FAIL-1');
    failSessionLaunchIntent(store, 'FAIL-1', T0);
    implIntent(ticketId, 'SUP-1');
    supersedePendingLaunchIntents(store, ticketId, 'implementation', 'other', T0);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getSessionLaunchIntent(store, 'FAIL-1')!.status).toBe('failed');
    expect(getSessionLaunchIntent(store, 'SUP-1')!.status).toBe('superseded');
  });

  it('does not nudge an intent superseded between select and send', () => {
    const launchId = implIntent(ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(
      deps({
        nudge,
        // The status changes between the candidate read and the pre-send re-read.
        isLive: () => {
          supersedePendingLaunchIntents(store, ticketId, 'implementation', 'other', T0);
          return true;
        },
        now: () => AFTER_DELIVERY,
      }),
    );
    expect(nudge).not.toHaveBeenCalled();
    expect(getSessionLaunchIntent(store, launchId)!.status).toBe('superseded');
  });

  it('skips another project’s intent', () => {
    const otherProject = upsertProject(store, { slug: 'other-proj' }).id;
    const otherTicket = createTicketFlow(store, {
      key: 'O-1',
      title: 'o',
      projectId: otherProject,
    }).id;
    transition(store, otherTicket, 'scope', { kind: 'passed' }); // -> impl
    implIntent(otherTicket, 'OTHER-1');
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
  });

  it('nudges a ticket with two pending intents at most once per tick', () => {
    // A never-confirmed implementation launch survives into the fix stage
    // (supersession is per purpose) alongside the fix launch: two pending
    // intents, one live session — the brief must go out once, not twice.
    implIntent(ticketId, 'STALE-IMPL-1', T0);
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'FIX-DUP-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getSessionLaunchIntent(store, 'STALE-IMPL-1')!.redeliveredAt).not.toBeNull();
    // The one-shot limit is per SESSION: both intents were stamped, so resolving
    // one must not let the survivor trigger a second nudge on a later tick.
    expect(getSessionLaunchIntent(store, 'FIX-DUP-1')!.redeliveredAt).not.toBeNull();
    supersedePendingLaunchIntents(store, ticketId, 'implementation', 'other', AFTER_DELIVERY);
    runFixWatchdog(deps({ nudge, now: () => NEXT_TICK }));
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('re-delivers a fresh fix launch even when a stale implementation intent was already re-delivered', () => {
    // The stale implementation intent stays pending after its re-delivery
    // (supersession is per purpose), so it must not claim the ticket's one
    // delivery slot and shadow the fresh fix launch — that is the exact loss
    // this guard exists to close.
    implIntent(ticketId, 'STALE-IMPL-1', T0);
    const nudge1 = vi.fn(() => true);
    runFixWatchdog(deps({ nudge: nudge1, now: () => AFTER_DELIVERY }));
    expect(nudge1).toHaveBeenCalledTimes(1);
    expect(getSessionLaunchIntent(store, 'STALE-IMPL-1')!.redeliveredAt).not.toBeNull();

    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'FIX-2',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: AFTER_DELIVERY,
    });
    const nudge2 = vi.fn(() => true);
    runFixWatchdog(deps({ nudge: nudge2, now: () => NEXT_TICK }));
    expect(nudge2).toHaveBeenCalledTimes(1);
    expect(getSessionLaunchIntent(store, 'FIX-2')!.redeliveredAt).not.toBeNull();
  });

  it('does not nudge when the ticket has a fix launch the park sweep fails this tick', () => {
    // A never-nudged implementation intent older than the stall window beside a
    // fix launch also past it: the fix launch is parked this tick, so the guard
    // must not tell the shared session to do work karst is simultaneously
    // declaring never started.
    implIntent(ticketId, 'STALE-IMPL-1', T0);
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'FIX-2',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const nudge = vi.fn(() => true);
    const settled = runFixWatchdog(
      deps({ nudge, timeoutMinutes: () => 1, now: () => new Date(Date.parse(T0) + 7 * 60_000).toISOString() }),
    );
    expect(nudge).not.toHaveBeenCalled();
    expect(settled).toBe(1);
    expect(getSessionLaunchIntent(store, 'FIX-2')!.status).toBe('failed');
  });

  it('still runs the park sweep when the re-delivery seam throws', () => {
    // A throwing host seam (a terminal closed between the liveness check and the
    // send) must not abort the tick before the park backstop runs.
    implIntent(ticketId);
    toFix(ticketId);
    stalledFix(ticketId);
    const nudge = vi.fn(() => {
      throw new Error('terminal was disposed');
    });
    const log = vi.fn();
    const settled = runFixWatchdog(
      deps({ nudge, log, timeoutMinutes: () => 1, now: () => new Date(Date.parse(T0) + 7 * 60_000).toISOString() }),
    );
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(settled).toBe(1);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    expect(log.mock.calls.some((c) => String(c[0]).includes('launch re-delivery failed'))).toBe(true);
  });

  it('skips an archived ticket', () => {
    implIntent(ticketId);
    archiveTicket(store, ticketId);
    const nudge = vi.fn(() => true);
    runFixWatchdog(deps({ nudge, now: () => AFTER_DELIVERY }));
    expect(nudge).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).agentState).not.toBe('not-started');
  });

  it('decides per ticket: one ticket’s stall does not suppress another ticket’s nudge', () => {
    // Ticket A: a fresh implementation launch (must be nudged). Ticket B: a fix
    // launch past the stall window (must be parked, not nudged). A decision that
    // looked at the union of candidates would let B's stall suppress A.
    implIntent(ticketId, 'A-IMPL', T0);
    const b = createTicketFlow(store, { key: 'T-2', title: 't2', projectId }).id;
    transition(store, b, 'scope', { kind: 'passed' }); // -> impl
    toFix(b);
    const bRound = pendingRound(b);
    recordFixLaunchIntent(store, {
      ticketId: b,
      launchId: 'B-FIX',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: bRound,
      at: T0,
    });
    const nudge = vi.fn((_id: number, _prompt: string) => true);
    const settled = runFixWatchdog(
      deps({ nudge, timeoutMinutes: () => 1, now: () => new Date(Date.parse(T0) + 7 * 60_000).toISOString() }),
    );
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge.mock.calls[0]![0]).toBe(ticketId);
    expect(settled).toBe(1);
    expect(getSessionLaunchIntent(store, 'B-FIX')!.status).toBe('failed');
  });

  it('re-delivers a fix launch still inside the stall window, without parking it', () => {
    // The delivery guard runs before the park sweep: an in-window fix launch is
    // re-delivered and left pending, never parked.
    toFix(ticketId);
    const roundId = pendingRound(ticketId);
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'ORDER-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const nudge = vi.fn(() => true);
    const settled = runFixWatchdog(
      deps({ nudge, timeoutMinutes: () => 60, now: () => new Date(Date.parse(T0) + 30 * 60_000).toISOString() }),
    );
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(settled).toBe(0);
    expect(getSessionLaunchIntent(store, 'ORDER-1')!.status).toBe('pending');
    expect(getSessionLaunchIntent(store, 'ORDER-1')!.redeliveredAt).not.toBeNull();
  });

  it('the startFixWatchdog activation tick runs the delivery guard with its injected seams', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_DELIVERY));
    const launchId = implIntent(ticketId);
    const nudge = vi.fn(() => true);
    const m = manifestFixture(
      {},
      {
        uat: uatFixture({ stallTimeoutMinutes: 1 }),
        review: reviewFixture({ stallTimeoutMinutes: 1 }),
      },
    );
    const watchdog = startFixWatchdog(store, () => m, () => projectId, () => {}, undefined, {
      isLive: () => true,
      nudge,
      isGraphTicket: () => false,
    });
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(getSessionLaunchIntent(store, launchId)!.redeliveredAt).not.toBeNull();
    watchdog.dispose();
  });

  it('does not nudge an intent deleted between select and send', () => {
    implIntent(ticketId, 'GONE-1');
    const nudge = vi.fn(() => true);
    const log = vi.fn();
    runFixWatchdog(
      deps({
        nudge,
        log,
        isLive: () => {
          store.db.prepare('DELETE FROM session_launch_intents WHERE launch_id = ?').run('GONE-1');
          return true;
        },
        now: () => AFTER_DELIVERY,
      }),
    );
    expect(nudge).not.toHaveBeenCalled();
    // The missing intent is handled quietly (skip), never as a failure.
    expect(log.mock.calls.some((c) => String(c[0]).includes('launch re-delivery failed'))).toBe(false);
  });

  it('does not park a stall inside a very large configured window', () => {
    toFix(ticketId);
    stalledFix(ticketId);
    // 100,000,000 minutes dwarfs the two-hour gap: the multiplication must be
    // minutes→ms, not a division that collapses the window to ~nothing.
    const settled = runFixWatchdog(deps({ timeoutMinutes: () => 100_000_000 }));
    expect(settled).toBe(0);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
  });

  it('keeps the 5-minute watchdog interval', () => {
    expect(FIX_WATCHDOG_INTERVAL_MS).toBe(300_000);
  });

  it('swallows a failing tick when no error sink is supplied', () => {
    vi.useFakeTimers();
    const watchdog = startFixWatchdog(
      store,
      () => {
        throw new Error('manifest boom');
      },
      () => projectId,
      () => {},
      undefined,
      { isLive: () => false, nudge: () => false, isGraphTicket: () => false },
    );
    // The constructor tick threw but the try/catch swallowed it: no onError
    // means no crash, and dispose still works.
    watchdog.dispose();
  });

  it('renders the re-delivery prompt for an implementation ticket', () => {
    const t = createTicketFlow(store, { key: 'IMPL-1', title: 'i', projectId }).id;
    transition(store, t, 'scope', { kind: 'passed' }); // -> impl
    const prompt = redeliveryPrompt(store, t);
    expect(prompt).toContain('launch brief did not reach you');
    expect(prompt).toContain('IMPL-1');
    // The context command carries --db (and --manifest), exactly as every
    // other karst prompt composes it — without --db the CLI exits 1.
    expect(prompt).toContain('context --db "$KARST_DB"');
    expect(prompt).toContain('--manifest "$KARST_MANIFEST"');
    expect(prompt).toContain('IMPL-1 --md');
    expect(prompt).toContain('--ticket IMPL-1');
    expect(prompt).toContain('stage impl pass');
  });

  it('renders the re-delivery prompt for a fix ticket with the fix marker', () => {
    toFix(ticketId);
    const prompt = redeliveryPrompt(store, ticketId);
    expect(prompt).toContain('The uat gate failed for ticket T-1');
    expect(prompt).toContain('--ticket T-1');
    expect(prompt).toContain('stage fix pass');
    expect(prompt).not.toContain('launch brief did not reach you');
  });

  it('falls back to a generic fix brief when there is no failed gate', () => {
    store.db.prepare("UPDATE tickets SET stage_current = 'fix' WHERE id = ?").run(ticketId);
    const prompt = redeliveryPrompt(store, ticketId);
    expect(prompt).toContain('A gate failed for ticket T-1');
    expect(prompt).toContain('stage fix pass');
  });

  it('renders a gate-only re-delivery prompt at a gate stage', () => {
    const t = createTicketFlow(store, { key: 'GATE-1', title: 'g', projectId }).id;
    transition(store, t, 'scope', { kind: 'passed' }); // -> impl
    transition(store, t, 'impl', { kind: 'passed' }); // -> uat
    const prompt = redeliveryPrompt(store, t);
    expect(prompt).toContain('no marker command to run here');
    expect(prompt).not.toContain('stage impl pass');
  });

  it('falls back to #id in the re-delivery prompt when the ticket has no key', () => {
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(ticketId);
    const prompt = redeliveryPrompt(store, ticketId);
    expect(prompt).toContain(`#${ticketId}`);
  });

  describe('sessionDelivery', () => {
    it('delegates liveness and the send to the session host', () => {
      const isLive = vi.fn(() => true);
      const nudge = vi.fn(() => true);
      const delivery = sessionDelivery(store, { isLive, nudge });

      expect(delivery.isLive(ticketId)).toBe(true);
      expect(delivery.nudge(ticketId, 'brief')).toBe(true);
      expect(isLive).toHaveBeenCalledWith(ticketId);
      expect(nudge).toHaveBeenCalledWith(ticketId, 'brief');
    });

    it('marks a graph-owned ticket as graph, a plain ticket as not', () => {
      const delivery = sessionDelivery(store, { isLive: () => false, nudge: () => false });
      expect(delivery.isGraphTicket(ticketId)).toBe(false);
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', ?)`,
        )
        .run(ticketId, T0);
      expect(delivery.isGraphTicket(ticketId)).toBe(true);
    });
  });
});
