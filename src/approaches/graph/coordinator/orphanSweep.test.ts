/**
 * Orphan sweep (T1139): open graph runs whose ticket no longer owns them are
 * closed through the one Cancel operation; a refused cancel is logged and left.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import type { ProcessFactsSource } from '../../../runtime/serverIdentity.js';
import type { CancelGraphRunDeps } from '../cancel.js';
import { sweepOrphanGraphRuns } from './orphanSweep.js';
import { reconcilableGraphRunIds } from './reconcileScope.js';

const STARTED = '2026-08-12T00:00:00.000Z';
const NOW = '2026-08-12T01:00:00.000Z';

type Db = ReturnType<typeof openStore>['db'];

interface TicketOpts {
  stage?: string;
  approach?: string | null;
  archived?: boolean;
}

function addRun(db: Db, key: string, status: string, opts: TicketOpts = {}): { ticketId: number; runId: number } {
  const ticketId = Number(
    db
      .prepare(
        `INSERT INTO tickets (key, project_id, stage_current, approach, archived_at)
         VALUES (?, 1, ?, ?, ?)`,
      )
      .run(
        key,
        opts.stage ?? 'impl',
        opts.approach === undefined ? 'graph-a' : opts.approach,
        opts.archived ? STARTED : null,
      ).lastInsertRowid,
  );
  const runId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'graph-a', ?, ?)`,
      )
      .run(ticketId, status, STARTED).lastInsertRowid,
  );
  return { ticketId, runId };
}

function deps(db: Db, facts?: ProcessFactsSource, logs: string[] = []): CancelGraphRunDeps {
  return {
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
        begin: 'immediate',
      })(),
    facts: facts ?? { isAlive: () => false, liveCwd: () => null, processStartMs: () => null },
    killTree: () => 'killed',
    now: () => NOW,
    debug: (m) => logs.push(m),
  };
}

const statusOf = (db: Db, id: number): string =>
  (db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(id) as { status: string }).status;

describe('sweepOrphanGraphRuns', () => {
  it('cancels the planning run of an archived ticket', async () => {
    const { db } = openStore(':memory:');
    const { runId } = addRun(db, 'T-1', 'planning', { archived: true });
    const result = await sweepOrphanGraphRuns(deps(db), 1);
    expect(result).toEqual({ cancelled: [runId], refused: [] });
    expect(statusOf(db, runId)).toBe('cancelled');
  });

  it('cancels the draining run of a done ticket', async () => {
    const { db } = openStore(':memory:');
    const { runId } = addRun(db, 'T-1', 'draining', { stage: 'done' });
    await sweepOrphanGraphRuns(deps(db), 1);
    expect(statusOf(db, runId)).toBe('cancelled');
  });

  it('cancels a run whose ticket left the run stage', async () => {
    const { db } = openStore(':memory:');
    const { runId } = addRun(db, 'T-1', 'running', { stage: 'uat' });
    await sweepOrphanGraphRuns(deps(db), 1);
    expect(statusOf(db, runId)).toBe('cancelled');
  });

  it('cancels a run whose ticket approach differs', async () => {
    const { db } = openStore(':memory:');
    const { runId } = addRun(db, 'T-1', 'running', { approach: 'other' });
    await sweepOrphanGraphRuns(deps(db), 1);
    expect(statusOf(db, runId)).toBe('cancelled');
  });

  it('leaves an active matching ticket, terminal runs and other projects untouched', async () => {
    const { db } = openStore(':memory:');
    const active = addRun(db, 'T-1', 'running');
    const closed = addRun(db, 'T-2', 'closed', { archived: true });
    const other = addRun(db, 'T-3', 'planning', { archived: true });
    db.prepare('UPDATE tickets SET project_id = 2 WHERE id = ?').run(other.ticketId);
    const result = await sweepOrphanGraphRuns(deps(db), 1);
    expect(result).toEqual({ cancelled: [], refused: [] });
    expect(statusOf(db, active.runId)).toBe('running');
    expect(statusOf(db, closed.runId)).toBe('closed');
    expect(statusOf(db, other.runId)).toBe('planning');
  });

  it('logs a refused cancel, leaves the run, and reconcile skips the archived ticket', async () => {
    const { db } = openStore(':memory:');
    const { ticketId, runId } = addRun(db, 'T-1', 'planning', { archived: true });
    const pr = Number(
      db
        .prepare(
          `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, pid, status, started_at)
           VALUES (?, 'impl', 'graph', 0, 4242, 'interrupted', ?)`,
        )
        .run(ticketId, STARTED).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, process_run_id)
       VALUES (?, 1, 'bootstrap', 'running', ?)`,
    ).run(runId, pr);
    const logs: string[] = [];
    // Alive pid with no start time: it cannot be attributed to this run.
    const facts: ProcessFactsSource = { isAlive: () => true, liveCwd: () => null, processStartMs: () => null };
    const result = await sweepOrphanGraphRuns(deps(db, facts, logs), 1);
    expect(result).toEqual({ cancelled: [], refused: [runId] });
    expect(statusOf(db, runId)).toBe('planning');
    expect(logs.some((m) => m.includes('orphan sweep') && m.includes('4242'))).toBe(true);
    expect(reconcilableGraphRunIds(db, { projectId: 1 })).toEqual([]);
  });
});
