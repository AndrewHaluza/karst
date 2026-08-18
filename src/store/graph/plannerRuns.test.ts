/**
 * Planner-run store: monotonic per-graph-run numbering, by-id reads, and the
 * transition map (Slice 2 Task 5).
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { createGraphRun } from './graphRuns.js';
import {
  createPlannerRun,
  nextPlannerRunNumber,
  plannerRunById,
  transitionPlannerRun,
} from './plannerRuns.js';
import { PLANNER_RUN_TRANSITIONS, GraphStoreError } from './transitions.js';

function harness(): { db: ReturnType<typeof openStore>['db']; graphRunId: number } {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = createGraphRun(store.db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
  return { db: store.db, graphRunId };
}

describe('planner-run store', () => {
  it('numbers planner runs monotonically per graph run', () => {
    const { db, graphRunId } = harness();
    expect(nextPlannerRunNumber(db, graphRunId)).toBe(1);
    createPlannerRun(db, { graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    expect(nextPlannerRunNumber(db, graphRunId)).toBe(2);
    createPlannerRun(db, { graphRunId, plannerRunNumber: 2, kind: 'replan' });
    expect(nextPlannerRunNumber(db, graphRunId)).toBe(3);
  });

  it('restarts numbering per graph run', () => {
    const { db, graphRunId } = harness();
    const ticketId = Number(
      db.prepare("INSERT INTO tickets (key) VALUES ('T-2')").run().lastInsertRowid,
    );
    const other = createGraphRun(db, {
      ticketId,
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: '2026-08-11T00:00:00.000Z',
    });
    createPlannerRun(db, { graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    createPlannerRun(db, { graphRunId, plannerRunNumber: 2, kind: 'replan' });
    expect(nextPlannerRunNumber(db, other)).toBe(1);
  });

  it('round-trips a planner run by id', () => {
    const { db, graphRunId } = harness();
    const id = createPlannerRun(db, { graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    const row = plannerRunById(db, id);
    expect(row).toMatchObject({
      id,
      graph_run_id: graphRunId,
      planner_run_number: 1,
      kind: 'bootstrap',
      status: 'ready',
      compile_attempt: 0,
      launch_attempt: 0,
    });
  });

  it('applies a legal transition and rejects a stale CAS', () => {
    const { db, graphRunId } = harness();
    const id = createPlannerRun(db, { graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    expect(transitionPlannerRun(db, id, 'ready', 'launching')).toBe(true);
    expect(transitionPlannerRun(db, id, 'ready', 'launching')).toBe(false);
    expect(plannerRunById(db, id)!.status).toBe('launching');
  });

  it('admits exactly the documented planner-run pairs', () => {
    const pairs = new Set<string>();
    for (const [from, tos] of Object.entries(PLANNER_RUN_TRANSITIONS)) {
      for (const to of tos) pairs.add(`${from} → ${to}`);
    }
    const documented = [
      'ready → launching',
      'ready → cancelled',
      'ready → stale',
      'launching → running',
      'launching → launch-unknown',
      'launching → cancelled',
      'launching → stale',
      'running → submitted',
      'running → blocked',
      'running → cancelled',
      'running → stale',
      'submitted → stale',
      // The compile-repair turn: a submitted document the compiler rejected
      // with an attempt left re-prompts the SAME planner run.
      'submitted → blocked',
      'blocked → launching',
      'blocked → cancelled',
      'blocked → stale',
      'launch-unknown → cancelled',
    ];
    expect([...pairs].filter((p) => !documented.includes(p))).toEqual([]);
    expect([...documented].filter((p) => !pairs.has(p))).toEqual([]);
  });

  it('rejects a pair absent from the map', () => {
    const { db, graphRunId } = harness();
    const id = createPlannerRun(db, { graphRunId, plannerRunNumber: 1, kind: 'bootstrap' });
    expect(() => transitionPlannerRun(db, id, 'ready', 'running')).toThrow(GraphStoreError);
  });
});
