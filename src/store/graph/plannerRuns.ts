/**
 * Planner-run store: one monotonic planner-run number per graph run. The
 * durable bootstrap `PlannerRun` lifecycle lives in the coordinator
 * (`approaches/graph/coordinator/plannerRun.ts`, Slice-2 T5); this module is
 * the store half.
 */

import type { GraphDb } from './transitions.js';

export interface CreatePlannerRun {
  graphRunId: number;
  plannerRunNumber: number;
  kind: 'bootstrap' | 'replan';
}

export function createPlannerRun(db: GraphDb, input: CreatePlannerRun): number {
  const res = db
    .prepare(
      `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
       VALUES (?, ?, ?, 'ready')`,
    )
    .run(input.graphRunId, input.plannerRunNumber, input.kind);
  return Number(res.lastInsertRowid);
}
