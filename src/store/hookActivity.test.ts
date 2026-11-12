import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import {
  openRecoveryRound,
  beginLiveFixExecution,
  sweepStalledFixRounds,
  listRecoveryRounds,
  parkFixStage,
  FIX_PARKED_STALLED,
  FIX_PARKED_EXHAUSTED,
  FIX_PARKED_INTERRUPTED,
  FIX_PARKED_REVIEW_STALLED,
  FIX_PARKED_LAUNCH_NEVER_STARTED,
  FIX_PARKED_NO_EXECUTION,
  type RecoveryRound,
} from './recoveryRounds.js';
import { getTicket } from './tickets.js';
import { upsertProject } from './projects.js';
import { openProcessRun, listProcessRuns } from './processRuns.js';
import { stampHookActivity, liftStalledFixPark } from './hookActivity.js';

const T0 = '2026-08-01T10:00:00.000Z';
const T_PARK = '2026-08-01T11:30:00.000Z';
const T_SWEEP = '2026-08-01T12:00:00.000Z';
const WINDOW_MS = 60 * 60_000;
const minutesBefore = (iso: string, m: number): string =>
  new Date(Date.parse(iso) - m * 60_000).toISOString();

describe('hook activity — fix stall watchdog', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    projectId = upsertProject(store, { slug: 'hook-proj' }).id;
    store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(projectId, ticketId);
  });
  afterEach(() => store.close());

  function openRound(): RecoveryRound {
    return openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    });
  }

  function toFix(): void {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    store.db
      .prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'")
      .run(T0, ticketId);
  }

  function liveFix(): RecoveryRound {
    toFix();
    const r = openRound();
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
    return r;
  }

  const sweep = (at = T_SWEEP) => sweepStalledFixRounds(store, { at, timeoutMs: WINDOW_MS, projectId });
  const fixStage = () => getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
  const lastHookAt = () =>
    (store.db.prepare('SELECT last_hook_at AS v FROM tickets WHERE id = ?').get(ticketId) as { v: string | null }).v;

  describe('stampHookActivity', () => {
    it('writes the time on the ticket', () => {
      stampHookActivity(store, ticketId, T0);
      expect(lastHookAt()).toBe(T0);
    });

    it('never moves the stamp backwards', () => {
      stampHookActivity(store, ticketId, T_SWEEP);
      stampHookActivity(store, ticketId, T0);
      expect(lastHookAt()).toBe(T_SWEEP);
    });
  });

  describe('sweepStalledFixRounds window', () => {
    it('T1091: does not park a fix with a hook event 7 minutes before the sweep', () => {
      liveFix(); // run started T0, no guide pull: both older than the window
      stampHookActivity(store, ticketId, minutesBefore(T_SWEEP, 7));

      expect(sweep()).toEqual([]);
      expect(fixStage().status).toBe('running');
    });

    it('parks a fix whose only hook event is older than the window', () => {
      liveFix();
      stampHookActivity(store, ticketId, minutesBefore(T_SWEEP, 61));

      expect(sweep()).toHaveLength(1);
      expect(fixStage().verdict).toBe(FIX_PARKED_STALLED);
    });

    it('parks a fix with no hook event, as before', () => {
      liveFix();
      expect(sweep()).toHaveLength(1);
    });

    it('still counts a fresh fix run start as progress', () => {
      toFix();
      const r = openRound();
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: minutesBefore(T_SWEEP, 5) });
      stampHookActivity(store, ticketId, minutesBefore(T_SWEEP, 300));
      expect(sweep()).toEqual([]);
    });

    it('still counts a fresh guide pull as progress', () => {
      liveFix();
      openProcessRun(store, {
        ticketId,
        stageKey: 'impl',
        processId: 'guide-pull',
        attempt: 0,
        startedAt: minutesBefore(T_SWEEP, 5),
      });
      expect(sweep()).toEqual([]);
    });

    it('uses the newest of the three sources', () => {
      liveFix();
      openProcessRun(store, {
        ticketId,
        stageKey: 'impl',
        processId: 'guide-pull',
        attempt: 0,
        startedAt: minutesBefore(T_SWEEP, 120),
      });
      stampHookActivity(store, ticketId, minutesBefore(T_SWEEP, 30));
      expect(sweep()).toEqual([]);
    });
  });

  describe('liftStalledFixPark', () => {
    function stallThenPark(): RecoveryRound {
      const r = liveFix();
      expect(sweep(T_PARK)).toHaveLength(1);
      return r;
    }

    it('reopens the round, attaches a live run and sets the fix stage running', () => {
      const r = stallThenPark();
      expect(fixStage().status).toBe('failed');

      expect(liftStalledFixPark(store, ticketId, T_SWEEP)).toBe(true);

      const round = listRecoveryRounds(store, ticketId).find((x) => x.id === r.id)!;
      expect(round.status).toBe('fixing');
      expect(fixStage()).toMatchObject({ status: 'running', verdict: null, endedAt: null });
      expect(listProcessRuns(store, ticketId).filter((p) => p.processId === 'fix' && p.status === 'running')).toHaveLength(1);
    });

    it('does not lift twice', () => {
      stallThenPark();
      expect(liftStalledFixPark(store, ticketId, T_SWEEP)).toBe(true);
      expect(liftStalledFixPark(store, ticketId, T_SWEEP)).toBe(false);
    });

    it('stays parked when the interrupt budget is spent', () => {
      const r = stallThenPark();
      store.db.prepare('UPDATE recovery_rounds SET interrupt_count = max_rounds WHERE id = ?').run(r.id);

      expect(liftStalledFixPark(store, ticketId, T_SWEEP)).toBe(false);
      expect(fixStage().status).toBe('failed');
    });

    it('does nothing for a ticket that never parked', () => {
      liveFix();
      expect(liftStalledFixPark(store, ticketId, T_SWEEP)).toBe(false);
      expect(fixStage().status).toBe('running');
    });

    it.each([
      ['attempts exhausted', FIX_PARKED_EXHAUSTED],
      ['interrupted', FIX_PARKED_INTERRUPTED],
      ['review stalled', FIX_PARKED_REVIEW_STALLED],
      ['launch never started', FIX_PARKED_LAUNCH_NEVER_STARTED],
      ['no execution', FIX_PARKED_NO_EXECUTION],
    ])('does not lift a "%s" park', (_name, verdict) => {
      const r = liveFix();
      store.db
        .prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ?, interrupt_count = 1 WHERE id = ?")
        .run(T_PARK, r.id);
      expect(parkFixStage(store, ticketId, verdict, T_PARK)).toBe(true);

      expect(liftStalledFixPark(store, ticketId, T_SWEEP)).toBe(false);
      expect(fixStage()).toMatchObject({ status: 'failed', verdict });
      expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    });

    it('does not lift when the event is not after the park time', () => {
      stallThenPark();
      expect(liftStalledFixPark(store, ticketId, minutesBefore(T_PARK, 1))).toBe(false);
    });
  });
});
