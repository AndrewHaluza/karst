import type { Store } from './db.js';
import { archiveTicket, type ProjectScope } from './tickets.js';

export interface DoneAutoArchiveInput {
  /**
   * Days a ticket stays visible at `done` before the sweep archives it
   * (manifest `archiveDoneAfterDays`; a positive whole number by validation).
   */
  afterDays: number;
  /** Test seam: the sweep's clock. Defaults to now. */
  now?: Date;
  scope?: ProjectScope;
}

/**
 * Auto-archive tickets whose `done` stage ended at or before the delay cutoff.
 *
 * The clock is the done stage row's `ended_at`, stamped by `transition`'s
 * entry patch when the ticket ARRIVES at `done` and OVERWRITTEN when it
 * re-enters (stages is keyed by (ticket_id, stage_key)) — so a ticket that
 * went back to work and reached done again restarts its own delay, and a
 * ticket that left done is not selected at all (stage_current guard).
 *
 * Guards, each load-bearing:
 * - `archived_at IS NULL` — a human who archived first wins; the sweep never
 *   revives or re-stamps an archived ticket, which is what makes re-runs
 *   idempotent (the second run selects nothing).
 * - `status = 'passed'` AND `ended_at IS NOT NULL` — `deriveStageCurrent` can
 *   recover `stage_current = 'done'` from a row that never actually entered
 *   the stage; a pending row with no end time is "the clock is unknown",
 *   never "the delay has elapsed".
 * - Project scope — the DB lives in global storage and every window shares it.
 *
 * Pure store read/write: no git, no gh, no event loop risk. The caller decides
 * when to run it (the periodic PR sweep, per the ticket's "runs periodically,
 * not just on status change" requirement).
 */
export function autoArchiveDoneTickets(
  store: Store,
  input: DoneAutoArchiveInput,
): number[] {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - input.afterDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const scoped = input.scope?.projectId !== undefined;
  const params: unknown[] = scoped ? [cutoff, input.scope!.projectId] : [cutoff];
  const scopeSql = scoped ? 'AND t.project_id = ?' : '';

  const rows = store.db
    .prepare(
      `SELECT t.id FROM tickets t
       JOIN stages s ON s.ticket_id = t.id AND s.stage_key = 'done'
       WHERE t.stage_current = 'done'
         AND t.archived_at IS NULL
         AND s.status = 'passed'
         AND s.ended_at IS NOT NULL
         AND s.ended_at <= ?
         ${scopeSql}`,
    )
    .all(...params) as { id: number }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const apply = store.db.transaction(() => {
    for (const id of ids) archiveTicket(store, id);
  });
  apply();
  return ids;
}
