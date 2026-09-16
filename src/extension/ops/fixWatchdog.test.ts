import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import {
  openRecoveryRound,
  beginLiveFixExecution,
  listRecoveryRounds,
  FIX_PARKED_STALLED,
} from '../../store/recoveryRounds.js';
import { getTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { listProcessRuns } from '../../store/processRuns.js';
import {
  manifest as manifestFixture,
  uat as uatFixture,
  review as reviewFixture,
} from '../../manifest/fixtures.js';
import {
  runFixWatchdog,
  stallTimeoutMinutes,
  startFixWatchdog,
  FIX_WATCHDOG_INTERVAL_MS,
} from './fixWatchdog.js';

const T0 = '2026-08-01T10:00:00.000Z';
const T2 = '2026-08-01T12:00:00.000Z';

describe('fixWatchdog', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'watchdog-proj' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
  });
  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function toFix(ticket: number): void {
    transition(store, ticket, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    store.db
      .prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'")
      .run(T0, ticket);
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

  it('parks a stalled round and logs it once', () => {
    toFix(ticketId);
    stalledFix(ticketId);
    const logged: string[] = [];

    const settled = runFixWatchdog({
      store,
      timeoutMinutes: () => 60,
      projectId: () => projectId,
      now: () => T2,
      log: (m) => logged.push(m),
    });

    expect(settled).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('showed no progress');
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('stale');
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.verdict).toBe(
      FIX_PARKED_STALLED,
    );
  });

  it('returns 0 and sweeps nothing for a non-finite or non-positive timeout', () => {
    toFix(ticketId);
    stalledFix(ticketId);
    const log = vi.fn();

    for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        runFixWatchdog({
          store,
          timeoutMinutes: () => minutes,
          projectId: () => projectId,
          now: () => T2,
          log,
        }),
      ).toBe(0);
    }

    expect(log).not.toHaveBeenCalled();
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
  });

  it('logs nothing and returns 0 when there is nothing to settle', () => {
    const log = vi.fn();
    expect(
      runFixWatchdog({
        store,
        timeoutMinutes: () => 60,
        projectId: () => projectId,
        now: () => T2,
        log,
      }),
    ).toBe(0);
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
    const watchdog = startFixWatchdog(store, () => m, () => projectId, log);

    // The activation tick settles the stall with no interval elapsed.
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    expect(log).toHaveBeenCalledTimes(1);

    watchdog.dispose();
    const other = createTicketFlow(store, { key: 'T-2', title: 't2', projectId }).id;
    transition(store, other, 'scope', { kind: 'passed' });
    transition(store, other, 'impl', { kind: 'passed' });
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
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain('watchdog tick failed');
    watchdog.dispose();
  });
});
