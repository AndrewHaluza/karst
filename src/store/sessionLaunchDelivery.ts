import type { Store } from './db.js';
import type { LaunchPurpose } from './sessionLaunchIntents.js';

/**
 * Reads behind the launch-delivery guard (v68).
 *
 * A launch is PREPARED before its terminal exists (`recordSessionLaunchIntent`)
 * and stays `pending` until a SessionStart confirms it. Nothing else ever
 * checks that the agent actually received its brief: a launch whose kickoff was
 * silently dropped leaves the intent `pending` and the session idling at its
 * prompt until the user types. This module answers "which prepared launches are
 * old enough that a missing SessionStart is no longer just startup latency",
 * covering BOTH purposes (the fix-only abandoned-launch sweep never covered
 * implementation launches). The guard itself lives in the watchdog tick.
 */

export interface DeliveryCheckOpts {
  /** The sweep's clock, ISO-8601. */
  at: string;
  /** How long a launch may stay pending before the guard acts. */
  minAgeMs: number;
  /**
   * The project whose window is running the guard. The registry is shared by
   * every window, so the read is project-scoped: one project's window must
   * never re-deliver or accuse another project's launches. `null` (no project
   * bound) selects nothing.
   */
  projectId: number | null;
}

export interface DeliveryCandidate {
  intentId: number;
  launchId: string;
  ticketId: number;
  purpose: LaunchPurpose;
  /** The core the launch resolved to; the guard skips cores with no confirmation path. */
  provider: string;
  createdAt: string;
  /** NULL = never re-delivered; a stamp means the guard already tried once. */
  redeliveredAt: string | null;
}

interface DeliveryCandidateRow {
  intent_id: number;
  launch_id: string;
  ticket_id: number;
  purpose: string;
  provider: string;
  created_at: string;
  redelivered_at: string | null;
}

/**
 * Every still-`pending` launch of the bound project older than `minAgeMs`,
 * regardless of purpose, EXCLUDING paused tickets and tickets that are no
 * longer at an interactive stage.
 *
 * A paused ticket is a refusal to start work (see `docs/arch/stages-and-gates.md`),
 * so the guard neither re-delivers into it nor marks it needs-you; an ARCHIVED
 * ticket is the same refusal at the end of its life — every surface that would
 * explain the state excludes it, so nudging its session would be an invisible
 * action. Graph-owned tickets are excluded by the caller (the graph surface is
 * a host predicate, not a column), as are cores with no SessionStart
 * confirmation path (the caller reads `providerConfirmsLaunch`; an intent that
 * can never confirm is not evidence of a lost brief). `confirmed`/`failed`/
 * `superseded` intents are excluded by the `status = 'pending'` filter — those
 * launches are settled.
 *
 * The stage bound is load-bearing: a launch intent is recorded ONLY while the
 * ticket is at `impl` or `fix` (`onLaunchPrepared` derives its purpose from
 * `stage_current`), so a pending intent on a ticket that has since advanced
 * (e.g. reached `done`) is stale — the session that was launched already did
 * its work. Re-delivering into it, or flagging it needs-you, would accuse a
 * finished ticket forever.
 */
export function selectDeliveryCandidates(
  store: Store,
  opts: DeliveryCheckOpts,
): DeliveryCandidate[] {
  const nowMs = Date.parse(opts.at);
  if (!Number.isFinite(nowMs)) return [];
  if (!(opts.minAgeMs > 0)) return [];
  if (opts.projectId === null) return [];
  const cutoff = new Date(nowMs - opts.minAgeMs).toISOString();

  const rows = store.db
    .prepare(
      `SELECT i.id AS intent_id, i.launch_id, i.ticket_id, i.purpose,
              i.provider, i.created_at, i.redelivered_at
         FROM session_launch_intents i
         JOIN tickets t ON t.id = i.ticket_id
        WHERE i.status = 'pending'
          AND i.created_at < ?
          AND t.project_id = ?
          AND t.paused_at IS NULL
          AND t.archived_at IS NULL
          AND t.stage_current IN ('impl','fix')
        ORDER BY i.id`,
    )
    .all(cutoff, opts.projectId) as DeliveryCandidateRow[];

  return rows.map((r) => ({
    intentId: r.intent_id,
    launchId: r.launch_id,
    ticketId: r.ticket_id,
    purpose: r.purpose as LaunchPurpose,
    provider: r.provider,
    createdAt: r.created_at,
    redeliveredAt: r.redelivered_at,
  }));
}
