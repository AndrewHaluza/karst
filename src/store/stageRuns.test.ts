import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import {
  openStageRun,
  closeStageRun,
  listStageRuns,
  latestStageRun,
  previousStageRun,
  reconcileStageRuns,
  describeStaleStageRun,
} from './stageRuns.js';
import { listGateRuns, recordGateRun } from './gateRuns.js';

/**
 * `stage_runs` exists to answer the one question `gate_runs` cannot: did a run
 * happen at all. A stage reading `running` with zero gate rows used to mean
 * three incompatible things at once — never started, in flight, destroyed — and
 * a session had to read the SQLite file by hand to guess which.
 */
describe('stage_runs', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  const open = (over: Partial<Parameters<typeof openStageRun>[1]> = {}): number =>
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-04T11:34:33.484Z',
      startedAt: '2026-08-04T11:34:33.484Z',
      pid: 4242,
      manifestHash: 'aaaa',
      ...over,
    });

  it('opens a run as running, with no outcome and no end', () => {
    const runId = open();
    const run = latestStageRun(store, id, 'review');
    expect(run).toMatchObject({
      id: runId,
      stageKey: 'review',
      status: 'running',
      outcome: null,
      endedAt: null,
      attempt: 0,
      pid: 4242,
      manifestHash: 'aaaa',
    });
  });

  it('closes a run with the outcome it reached', () => {
    const runId = open();
    closeStageRun(store, runId, 'advanced', '2026-08-04T12:11:38.092Z');
    expect(latestStageRun(store, id, 'review')).toMatchObject({
      status: 'finished',
      outcome: 'advanced',
      endedAt: '2026-08-04T12:11:38.092Z',
    });
  });

  it('marks a still-open run stale the moment a new run supersedes it', () => {
    // The driver single-flights per ticket, so a run still open when the next
    // one starts is one whose host died. Marking it here rather than waiting
    // for an activation sweep is what stops a destroyed run from reading
    // `running` beside the run that replaced it.
    open();
    open({ runAt: '2026-08-04T12:00:03.983Z', startedAt: '2026-08-04T12:00:03.983Z' });
    expect(listStageRuns(store, id).map((r) => r.status)).toEqual(['stale', 'running']);
  });

  it('does not let a late finisher overwrite the stale mark it was given', () => {
    const first = open();
    open({ runAt: '2026-08-04T12:00:03.983Z', startedAt: '2026-08-04T12:00:03.983Z' });
    closeStageRun(store, first, 'advanced', '2026-08-04T12:05:00.000Z');
    expect(listStageRuns(store, id)[0]).toMatchObject({
      status: 'stale',
      outcome: null,
      endedAt: null,
    });
  });

  it('leaves another stage alone when a run of this one is superseded', () => {
    open({ stageKey: 'uat' });
    open();
    expect(listStageRuns(store, id).map((r) => [r.stageKey, r.status])).toEqual([
      ['uat', 'running'],
      ['review', 'running'],
    ]);
  });

  it('reads the previous run of the same stage, stale ones included', () => {
    open();
    const second = open({ runAt: '2026-08-04T12:00:03.983Z', startedAt: 'x', manifestHash: 'bbbb' });
    const run = listStageRuns(store, id).find((r) => r.id === second)!;
    // The predecessor was destroyed, but it RAN, and comparing against it is
    // how "the gate set changed since the previous attempt" is stated.
    expect(previousStageRun(store, run)).toMatchObject({ status: 'stale', manifestHash: 'aaaa' });
  });

  describe('reconcileStageRuns', () => {
    it('marks a run whose process is gone stale, and reports it', () => {
      open();
      const stale = reconcileStageRuns(store, () => false);
      expect(stale).toHaveLength(1);
      expect(latestStageRun(store, id, 'review')?.status).toBe('stale');
      expect(describeStaleStageRun(stale[0]!)).toContain('did not finish');
    });

    it('leaves a run whose process is still alive strictly alone', () => {
      // Another IDE window sweeping the shared registry must never touch a run
      // this one has in flight. The scope is global; what makes that safe is
      // the liveness probe, not the scope.
      open();
      expect(reconcileStageRuns(store, () => true)).toEqual([]);
      expect(latestStageRun(store, id, 'review')?.status).toBe('running');
    });

    it('leaves a run with no recorded pid alone — absence is not evidence of death', () => {
      open({ pid: null });
      expect(reconcileStageRuns(store, () => false)).toEqual([]);
      expect(latestStageRun(store, id, 'review')?.status).toBe('running');
    });

    it('never claims to know when a killed run stopped', () => {
      open();
      reconcileStageRuns(store, () => false);
      // The sweep's own clock would say the run lived until this activation,
      // which may be days after the process died.
      expect(latestStageRun(store, id, 'review')?.endedAt).toBeNull();
    });

    it('does not re-report a run it already marked stale', () => {
      open();
      reconcileStageRuns(store, () => false);
      expect(reconcileStageRuns(store, () => false)).toEqual([]);
    });

    // The whole incident in one sequence (869edna84): a run opens, gates
    // finish and their rows land as they happen, the host dies, and the next
    // activation finds the run dead — the partial rows stay readable and the
    // loss is reported, never silent.
    it('keeps a dead run\'s partial gate rows readable and reports the loss end to end', () => {
      const runId = openStageRun(store, {
        ticketId: id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        startedAt: '2026-08-01T10:00:00.000Z',
        manifestHash: 'hash-a',
        pid: 4242,
      });
      recordGateRun(store, {
        ticketId: id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        gates: [{ gateName: 'lint (web)', exitCode: 0 }],
        stageRunId: runId,
      });
      // The host died; nothing ran. The sweep finds the dead pid.
      const stale = reconcileStageRuns(store, (pid) => pid !== 4242);
      expect(stale).toHaveLength(1);
      expect(stale[0]!.run.id).toBe(runId);
      // The run reads as destroyed — never as never-started, never in flight.
      expect(latestStageRun(store, id, 'review')).toMatchObject({
        status: 'stale',
        endedAt: null,
      });
      // Every gate that finished before the death is still readable.
      const rows = listGateRuns(store, id);
      expect(rows.map((r) => r.gateName)).toEqual(['lint (web)']);
      expect(rows[0]!.stageRunId).toBe(runId);
      expect(rows[0]!.exitCode).toBe(0);
    });
  });
});
