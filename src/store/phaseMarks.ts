import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * One phase an agent or the HOST recorded during a marker stage.
 *
 * A mark is evidence that a phase was entered, with a timestamp — the same
 * class of fact as the impl done marker, not the agent describing its progress
 * in prose. The absence of a mark is evidence of nothing at all: the agent may
 * have done the phase and not fired the marker, or the approach may predate the
 * marker entirely. An unmarked phase is unknown, never "skipped".
 */
export interface PhaseMark {
  id: number;
  ticketId: number;
  stageKey: StageKey;
  /** The stage's attempt when this mark landed. */
  attempt: number;
  /** As recorded. NOT constrained to the approach's declared phase list. */
  phaseName: string;
  markedAt: string;
  /** Who wrote it: the agent's `karst phase` command, or the host's evidence. */
  source: PhaseMarkSource;
  /**
   * v28: the stable implementation run the mark was recorded inside, when the
   * reporter named one. NULL for legacy marks and marks recorded outside a run
   * — absence is the truthful answer, never "unattributed by accident".
   */
  implementationRunId: number | null;
  /** v28: the segment the mark was recorded inside; NULL = none (or legacy). */
  implementationSegmentId: number | null;
}

/** The two writers of a phase mark. A host mark is evidence, never a verdict. */
export type PhaseMarkSource = 'agent' | 'host';

export interface PhaseMarkInput {
  ticketId: number;
  stageKey: StageKey;
  attempt: number;
  phaseName: string;
  markedAt: string;
  source: PhaseMarkSource;
  implementationRunId?: number | null;
  implementationSegmentId?: number | null;
}

interface PhaseMarkRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  attempt: number;
  phase_name: string;
  marked_at: string;
  source: string;
  implementation_run_id: number | null;
  implementation_segment_id: number | null;
}

function rowToPhaseMark(r: PhaseMarkRow): PhaseMark {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    attempt: r.attempt,
    phaseName: r.phase_name,
    markedAt: r.marked_at,
    source: r.source as PhaseMarkSource,
    implementationRunId: r.implementation_run_id,
    implementationSegmentId: r.implementation_segment_id,
  };
}

/**
 * The ticket's currently-open implementation run, when it has one — the run a
 * mark reported while a run was live is attributed to. Resolved INSIDE the
 * writer, like `attempt` and `markedAt`: the phase CLI's parse path is the
 * security boundary, so the attribution is a server-side fact a mark can never
 * forge from argv.
 */
function openRunIdFor(store: Store, ticketId: number): number | null {
  const row = store.db
    .prepare(
      `SELECT id FROM implementation_runs
        WHERE ticket_id = ? AND ended_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as { id: number } | undefined;
  return row === undefined ? null : row.id;
}

/**
 * Append one phase mark; returns true when a row was written.
 *
 * Two writers share this table:
 *
 *  - the agent, through `karst phase` (`source = 'agent'`). Agent marks still
 *    repeat: an approach may legitimately loop (research → plan → research), and
 *    collapsing that at write time would destroy the evidence the loop happened.
 *    The UI's decision to show a phase once is the model layer's.
 *  - the host, from evidence it already holds (`source = 'host'`, @arch:RESULTS).
 *    A host mark is an INFERENCE of phase entry, so it is written at most once
 *    per (ticket, stage, attempt, phase) and never when any mark already exists
 *    for that key — the agent's own report is the more exact fact.
 *
 * Symmetrically, an agent mark is not written when a HOST mark already holds
 * that key: the phase is entered either way, and a second row for one entry
 * would read as a re-entry the agent did not make. `karst phase` still exits 0.
 *
 * A phase name the approach never declared is stored verbatim for the same
 * reason: rejecting it here would silently discard the most interesting signal
 * available — that the agent went off-script.
 *
 * A mark whose caller names no run is attributed to the ticket's currently-open
 * `implementation_runs` row; NULL when there is none — a mark made outside a
 * run is a real state, not an error. An EXPLICIT run id always wins, so a
 * caller that recorded the run itself (the session lifecycle) keeps its link.
 *
 * Opens no transaction of its own, and uses only the driver-agnostic
 * `prepare(sql).run(...)` surface, because the marker CLI reaches this through
 * `node:sqlite` (`openWritableStore`) rather than the extension's better-sqlite3.
 * ONE statement does the insert and the duplicate check, so the check and the
 * write cannot race apart.
 */
export function recordPhaseMark(store: Store, mark: PhaseMarkInput): boolean {
  const implementationRunId = mark.implementationRunId ?? openRunIdFor(store, mark.ticketId);
  const info = store.db
    .prepare(
      `INSERT INTO phase_marks
         (ticket_id, stage_key, attempt, phase_name, marked_at,
          implementation_run_id, implementation_segment_id, source)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM phase_marks
           WHERE ticket_id = ? AND stage_key = ? AND attempt = ? AND phase_name = ?
             AND (? = 'host' OR source = 'host')
        )`,
    )
    .run(
      mark.ticketId,
      mark.stageKey,
      mark.attempt,
      mark.phaseName,
      mark.markedAt,
      implementationRunId ?? null,
      mark.implementationSegmentId ?? null,
      mark.source,
      mark.ticketId,
      mark.stageKey,
      mark.attempt,
      mark.phaseName,
      mark.source,
    );
  // `node:sqlite` can report `changes` as a bigint; the CLI reaches this path.
  return Number(info.changes) > 0;
}

/**
 * Every phase ever reported for a ticket, oldest first.
 *
 * Ordered by `id`, not by `marked_at`: insertion order is the record of what
 * karst was told and when it was told, and `marked_at` is supplied by the
 * caller, so a skewed clock must not be able to reorder history after the fact.
 *
 * Returns everything and groups nothing — filtering to the current attempt,
 * collapsing repeats, and reconciling reported against declared phases are all
 * pure decisions that belong in the model layer, where they are testable without
 * a database.
 */
export function listPhaseMarks(store: Store, ticketId: number): PhaseMark[] {
  return store.db
    .prepare(
      `SELECT id, ticket_id, stage_key, attempt, phase_name, marked_at, source,
              implementation_run_id, implementation_segment_id
         FROM phase_marks
        WHERE ticket_id = ?
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToPhaseMark(r as PhaseMarkRow));
}
