import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * One phase an agent REPORTED entering during a marker stage.
 *
 * A mark is evidence that a command ran, with a timestamp — the same class of
 * fact as the impl done marker, not the agent describing its progress in prose.
 * The absence of a mark is evidence of nothing at all: the agent may have done
 * the phase and not fired the marker, or the approach may predate the marker
 * entirely. An unmarked phase is unknown, never "skipped".
 */
export interface PhaseMark {
  id: number;
  ticketId: number;
  stageKey: StageKey;
  /** The stage's attempt when this mark landed. */
  attempt: number;
  /** As reported. NOT constrained to the approach's declared phase list. */
  phaseName: string;
  markedAt: string;
}

export interface PhaseMarkInput {
  ticketId: number;
  stageKey: StageKey;
  attempt: number;
  phaseName: string;
  markedAt: string;
}

interface PhaseMarkRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  attempt: number;
  phase_name: string;
  marked_at: string;
}

function rowToPhaseMark(r: PhaseMarkRow): PhaseMark {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    attempt: r.attempt,
    phaseName: r.phase_name,
    markedAt: r.marked_at,
  };
}

/**
 * Append one reported phase. Append-only, and deliberately never deduplicates:
 * an approach may legitimately loop (research → plan → research), and collapsing
 * that at write time would destroy the evidence the loop happened. Whether the
 * UI shows a phase once or twice is a presentation decision for the model layer.
 *
 * A phase name the approach never declared is stored verbatim for the same
 * reason: rejecting it here would silently discard the most interesting signal
 * available — that the agent went off-script.
 *
 * Opens no transaction of its own, and uses only the driver-agnostic
 * `prepare(sql).run(...)` surface, because the marker CLI reaches this through
 * `node:sqlite` (`openWritableStore`) rather than the extension's better-sqlite3.
 */
export function recordPhaseMark(store: Store, mark: PhaseMarkInput): void {
  store.db
    .prepare(
      `INSERT INTO phase_marks (ticket_id, stage_key, attempt, phase_name, marked_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(mark.ticketId, mark.stageKey, mark.attempt, mark.phaseName, mark.markedAt);
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
      `SELECT id, ticket_id, stage_key, attempt, phase_name, marked_at
         FROM phase_marks
        WHERE ticket_id = ?
        ORDER BY id`,
    )
    .all(ticketId)
    .map((r) => rowToPhaseMark(r as PhaseMarkRow));
}
