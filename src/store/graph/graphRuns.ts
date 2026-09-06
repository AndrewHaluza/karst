/**
 * Graph-run store: durable run creation per (ticket, stage attempt) and the
 * graph-run transition map, driven by the shared compare-and-set primitive.
 * Driver-agnostic (positional `?` only) — the CLI opens the same store.
 */

import type { GraphDb } from './transitions.js';
import { GRAPH_RUN_TRANSITIONS, casStatus } from './transitions.js';

export interface GraphRunRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  stage_attempt: number;
  approach_id: string;
  status: string;
  created_at: string;
}

export interface CreateGraphRun {
  ticketId: number;
  stageAttempt: number;
  approachId: string;
  now: string;
}

export function createGraphRun(db: GraphDb, input: CreateGraphRun): number {
  const res = db
    .prepare(
      `INSERT INTO approach_graph_runs
        (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (?, 'impl', ?, ?, 'planning', ?)`,
    )
    .run(input.ticketId, input.stageAttempt, input.approachId, input.now);
  return Number(res.lastInsertRowid);
}

export function graphRunById(db: GraphDb, id: number): GraphRunRow | undefined {
  return db
    .prepare('SELECT * FROM approach_graph_runs WHERE id = ?')
    .get(id) as GraphRunRow | undefined;
}

/**
 * The 1-based ordinal of `runId` among the ticket's OWN graph runs — the ONE
 * definition of the number every surface displays. `approach_graph_runs.id` is
 * a registry-wide row id shared by every ticket in the project; printing it
 * anywhere a human reads makes two surfaces of the same run disagree (the
 * report: a stage block reading `graph run 5` beside a panel reading `run 1`).
 */
export function graphRunOrdinal(db: GraphDb, ticketId: number, runId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_runs WHERE ticket_id = ? AND id <= ?')
    .get(ticketId, runId) as { n: number };
  return row.n;
}

/** The active graph run for a ticket/stage attempt, or undefined. */
export function graphRunForTicket(
  db: GraphDb,
  ticketId: number,
  stageAttempt: number,
): GraphRunRow | undefined {
  return db
    .prepare(
      'SELECT * FROM approach_graph_runs WHERE ticket_id = ? AND stage_attempt = ? ORDER BY id DESC LIMIT 1',
    )
    .get(ticketId, stageAttempt) as GraphRunRow | undefined;
}

/**
 * Compare-and-set a graph-run transition. Returns false when the row already
 * moved (a raced transition from another window) — never throws for a stale
 * caller, only for a pair absent from the transition map.
 */
export function transitionGraphRun(db: GraphDb, id: number, from: string, to: string): boolean {
  return casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, id, from, to);
}

/** True when every graph run of the ticket has status `closed` — the
 *  retention sweep's predicate (Slice 2 Task 8). */
export function allGraphRunsClosed(db: GraphDb, ticketId: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS open FROM approach_graph_runs WHERE ticket_id = ? AND status != 'closed' LIMIT 1",
    )
    .get(ticketId) as { open: number } | undefined;
  return row === undefined;
}
