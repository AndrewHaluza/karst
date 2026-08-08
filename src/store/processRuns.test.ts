import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket } from './tickets.js';
import { openStageRun } from './stageRuns.js';
import {
  openProcessRun,
  finishProcessRun,
  listProcessRuns,
  reconcileProcessRuns,
  describeStaleProcessRun,
  type ProcessRun,
  type ProcessRunStatus,
} from './processRuns.js';

/**
 * `process_runs` (v26) — one row per inside-process INVOCATION, opened before
 * the process starts and closed at its outcome.
 *
 * The inside redesign renders a stage as ordered PROCESSES (gates, commit,
 * delivery-receipt, recovery…), each carrying an AI identity snapshot and its
 * own evidence. The evidence tables (`gate_runs`, `review_findings`) record
 * what FINISHED; only a row opened at entry can say a process ran at all, and
 * only that row can carry who ran it (agent/provider/model) as it actually was
 * at that moment — an identity that must never be rewritten later.
 *
 * Same crash policy as `stage_runs`: append-only, superseded runs marked stale
 * (never deleted), a dead recorded pid reconciled to `stale` at activation, and
 * a late finisher never allowed to overwrite a stale mark.
 */
describe('process_runs', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
  });
  afterEach(() => store.close());

  const open = (over: Partial<Parameters<typeof openProcessRun>[1]> = {}): ProcessRun =>
    openProcessRun(store, {
      ticketId,
      stageKey: 'review',
      processId: 'review',
      attempt: 1,
      stageRunId: null,
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'sol',
      pid: 4242,
      startedAt: '2026-08-08T10:00:00.000Z',
      ...over,
    });

  it('opens a run as running, carrying the identity snapshot it was given', () => {
    const stageRunId = openStageRun(store, {
      ticketId,
      stageKey: 'review',
      attempt: 1,
      runAt: '2026-08-08T09:59:00.000Z',
      startedAt: '2026-08-08T09:59:00.000Z',
      pid: 4242,
    });
    const run = open({
      stageRunId,
      resultKind: 'passed',
      artifactPath: '/logs/review.log',
    });
    expect(run).toMatchObject({
      ticketId,
      stageKey: 'review',
      processId: 'review',
      attempt: 1,
      stageRunId,
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'sol',
      pid: 4242,
      status: 'running',
      resultKind: 'passed',
      artifactPath: '/logs/review.log',
      startedAt: '2026-08-08T10:00:00.000Z',
      endedAt: null,
    });
  });

  it('closes a run with the status it reached', () => {
    const run = open();
    finishProcessRun(store, run.id, 'passed', '2026-08-08T10:01:00.000Z');
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      provider: 'codex',
      model: 'sol',
      status: 'passed',
      endedAt: '2026-08-08T10:01:00.000Z',
    });
  });

  it('records every terminal status: passed, failed, interrupted', () => {
    const statuses: ProcessRunStatus[] = [];
    for (const status of ['passed', 'failed', 'interrupted'] as const) {
      const run = open({ processId: `proc-${status}` });
      finishProcessRun(store, run.id, status, `2026-08-08T11:0${statuses.length}.00.000Z`);
      statuses.push(listProcessRuns(store, ticketId).find((r) => r.id === run.id)!.status);
    }
    expect(statuses).toEqual(['passed', 'failed', 'interrupted']);
  });

  it('never rewrites the identity snapshot a run was opened with', () => {
    // The snapshot is what the execution ACTUALLY used at the moment it ran.
    // A later finish must not touch it — an overwritten provider/model here is
    // the evidence of a lie being written over the truth.
    const run = open({ provider: 'claude', model: 'opus' });
    finishProcessRun(store, run.id, 'passed', '2026-08-08T10:01:00.000Z');
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      provider: 'claude',
      model: 'opus',
      agentName: 'Review Agent',
      stageRunId: null,
      attempt: 1,
    });
  });

  it('marks a still-running run stale the moment a new run of the same process supersedes it', () => {
    open();
    open({ startedAt: '2026-08-08T10:30:00.000Z' });
    expect(listProcessRuns(store, ticketId).map((r) => r.status)).toEqual([
      'stale',
      'running',
    ]);
  });

  it('supersedes only the same process — a sibling process stays running', () => {
    open();
    open({ processId: 'commit', startedAt: '2026-08-08T10:30:00.000Z' });
    expect(listProcessRuns(store, ticketId).map((r) => [r.processId, r.status])).toEqual([
      ['review', 'running'],
      ['commit', 'running'],
    ]);
  });

  it('does not let a late finisher overwrite the stale mark it was given', () => {
    const first = open();
    open({ startedAt: '2026-08-08T10:30:00.000Z' });
    finishProcessRun(store, first.id, 'passed', '2026-08-08T10:35:00.000Z');
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      status: 'stale',
      endedAt: null,
    });
  });

  it('is a no-op when finishing a run that is no longer running', () => {
    const run = open();
    finishProcessRun(store, run.id, 'passed', '2026-08-08T10:01:00.000Z');
    // A second finish of an already-closed run must not rewrite its outcome.
    finishProcessRun(store, run.id, 'failed', '2026-08-08T10:02:00.000Z');
    expect(listProcessRuns(store, ticketId)[0]).toMatchObject({
      status: 'passed',
      endedAt: '2026-08-08T10:01:00.000Z',
    });
  });

  it('lists only the asked ticket, oldest first', () => {
    const other = createTicket(store, { key: 'T-2', title: 'other' }).id;
    open({ startedAt: '2026-08-08T09:00:00.000Z' });
    open({ startedAt: '2026-08-08T10:00:00.000Z' });
    openProcessRun(store, {
      ticketId: other,
      stageKey: 'review',
      processId: 'review',
      attempt: 1,
      startedAt: '2026-08-08T09:30:00.000Z',
    });
    const runs = listProcessRuns(store, ticketId);
    expect(runs.map((r) => r.ticketId)).toEqual([ticketId, ticketId]);
    expect(runs[0]!.startedAt).toBe('2026-08-08T09:00:00.000Z');
    expect(runs[1]!.startedAt).toBe('2026-08-08T10:00:00.000Z');
  });

  it('degrades an unrecognized status to the conservative answer on read', () => {
    const run = open();
    // The schema CHECK rejects the impossible status — which is why the degrade
    // is reached only by a foreign writer or a future karst's wider vocabulary.
    // Bypass the check for this one write so the read boundary is exercised.
    store.db.pragma('ignore_check_constraints = ON');
    store.db
      .prepare('UPDATE process_runs SET status = ? WHERE id = ?')
      .run('impossible', run.id);
    store.db.pragma('ignore_check_constraints = OFF');
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('stale');
  });

  describe('reconcileProcessRuns', () => {
    it('marks a run whose process is gone stale, and reports it', () => {
      open();
      const stale = reconcileProcessRuns(store, () => false);
      expect(stale).toHaveLength(1);
      expect(listProcessRuns(store, ticketId)[0]!.status).toBe('stale');
      const line = describeStaleProcessRun(stale[0]!);
      expect(line).toContain('did not finish');
      expect(line.split('\n')).toHaveLength(1);
    });

    it('leaves a run whose process is still alive strictly alone', () => {
      // Another IDE window sweeping the shared registry must never touch a run
      // this one has in flight. The scope is global; what makes that safe is
      // the liveness probe, not the scope.
      open();
      expect(reconcileProcessRuns(store, () => true)).toEqual([]);
      expect(listProcessRuns(store, ticketId)[0]!.status).toBe('running');
    });

    it('leaves a run with no recorded pid alone — absence is not evidence of death', () => {
      open({ pid: null });
      expect(reconcileProcessRuns(store, () => false)).toEqual([]);
      expect(listProcessRuns(store, ticketId)[0]!.status).toBe('running');
    });

    it('never claims to know when a killed run stopped', () => {
      open();
      reconcileProcessRuns(store, () => false);
      // The sweep's own clock would say the run lived until this activation,
      // which may be days after the process died.
      expect(listProcessRuns(store, ticketId)[0]!.endedAt).toBeNull();
    });

    it('does not re-report a run it already marked stale', () => {
      open();
      reconcileProcessRuns(store, () => false);
      expect(reconcileProcessRuns(store, () => false)).toEqual([]);
    });
  });
});
