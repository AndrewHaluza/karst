import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * A gate stage row that reads `running` while nothing is running it.
 *
 * `advance` enters the next gate stage `running` and relies on a `maybeDrive`
 * trigger to start it. When every trigger is dead (hook lockout, a session that
 * idles without exiting) the row stays `running` with no `stage_runs` row for
 * its attempt and no open `process_runs` row — and `stallTimeoutMinutes` has no
 * run to time out (docs/issues/2026-10-21-stranded-uat-after-fix-marker.md).
 */
export interface StrandedStage {
  ticketId: number;
  stageKey: StageKey;
  attempt: number;
}

/** The advance → driver-start window: a row this young is a normal handoff, not a strand. */
export const STRANDED_STAGE_GRACE_MS = 2 * 60_000;

export interface SelectStrandedStagesOpts {
  at: string;
  graceMs?: number;
  /** Only this project's tickets: the registry is shared by every window. `null` selects nothing. */
  projectId: number | null;
}

/**
 * Select the driver-owned gate stages (`uat`, `review`) that are the ticket's
 * current stage, read `running` past the grace period, and have neither an open
 * stage run for that attempt nor any open process run. Paused, archived and
 * already-blocked tickets are left alone. Pure selection — the caller decides
 * what to do (re-drive, then park).
 */
export function selectStrandedStages(store: Store, opts: SelectStrandedStagesOpts): StrandedStage[] {
  const nowMs = Date.parse(opts.at);
  if (!Number.isFinite(nowMs) || opts.projectId === null) return [];
  const cutoff = new Date(nowMs - (opts.graceMs ?? STRANDED_STAGE_GRACE_MS)).toISOString();
  const rows = store.db
    .prepare(
      `SELECT s.ticket_id, s.stage_key, s.attempt
         FROM stages s
         JOIN tickets t ON t.id = s.ticket_id AND t.stage_current = s.stage_key
        WHERE s.status = 'running'
          AND s.stage_key IN ('uat', 'review')
          AND s.blocked_kind IS NULL
          AND s.started_at IS NOT NULL AND s.started_at < ?
          AND t.project_id = ?
          AND t.paused_at IS NULL AND t.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM recovery_rounds x
                           WHERE x.ticket_id = s.ticket_id AND x.source_stage = s.stage_key
                             AND x.status = 'exhausted')
          AND NOT EXISTS (SELECT 1 FROM stage_runs r
                           WHERE r.ticket_id = s.ticket_id AND r.stage_key = s.stage_key
                             AND r.attempt = s.attempt AND r.status = 'running')
          AND NOT EXISTS (SELECT 1 FROM process_runs p
                           WHERE p.ticket_id = s.ticket_id AND p.status = 'running')
        ORDER BY s.ticket_id`,
    )
    .all(cutoff, opts.projectId) as { ticket_id: number; stage_key: string; attempt: number }[];
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    attempt: r.attempt,
  }));
}
