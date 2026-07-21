import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * One recorded gate result — what a gate runner reported, kept after the fact.
 *
 * `exitCode: null` means the repo defines no such script, so karst had no
 * question to ask. That is neither a pass nor a fail, and it must never be
 * flattened into `0`: a gate that could not run did not go green.
 */
export interface GateRun {
  id: number;
  ticketId: number;
  stageKey: StageKey;
  attempt: number;
  /** Batch stamp shared by every gate of one runner invocation. */
  runAt: string;
  gateName: string;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** One gate as a runner reports it, before it has an id or a batch stamp. */
export interface GateRunInput {
  gateName: string;
  exitCode: number | null;
  /** Absent for a gate that never ran — it has no duration to state. */
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface GateRunBatch {
  ticketId: number;
  stageKey: StageKey;
  /** The stage's attempt at the moment this batch ran. */
  attempt: number;
  runAt: string;
  gates: readonly GateRunInput[];
}

interface GateRunRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  attempt: number;
  run_at: string;
  gate_name: string;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
}

function rowToGateRun(r: GateRunRow): GateRun {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    attempt: r.attempt,
    runAt: r.run_at,
    gateName: r.gate_name,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/**
 * Append one runner invocation's gates. Taken as a batch, not gate by gate, so
 * every row of one invocation shares `runAt` and the batch can be recovered
 * later without depending on `attempt` (which does not increment on a pass).
 *
 * Deliberately opens no transaction of its own: it is called from inside
 * `transition`'s premutate, so the gates and the verdict they produced commit
 * together or not at all.
 */
export function recordGateRun(store: Store, batch: GateRunBatch): void {
  const insert = store.db.prepare(
    `INSERT INTO gate_runs
       (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const g of batch.gates) {
    insert.run(
      batch.ticketId,
      batch.stageKey,
      batch.attempt,
      batch.runAt,
      g.gateName,
      g.exitCode,
      g.startedAt ?? null,
      g.endedAt ?? null,
    );
  }
}

/**
 * Every gate ever recorded for a ticket, oldest first (insertion order is run
 * order). Returns everything and groups nothing: picking "the latest batch" is a
 * pure decision that belongs in the model layer, where it is testable without a
 * database.
 */
export function listGateRuns(store: Store, ticketId: number): GateRun[] {
  return store.db
    .prepare(
      `SELECT id, ticket_id, stage_key, attempt, run_at, gate_name, exit_code,
              started_at, ended_at
         FROM gate_runs
        WHERE ticket_id = ?
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToGateRun(r as GateRunRow));
}
