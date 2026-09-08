import type { Store } from '../db.js';
import { mean, percentile, ratio, scopeSql, type MetricsScope } from './scope.js';

/**
 * Delivery-family effectiveness metrics: did the ticket get through, how long
 * did it take, and what did it cost in friction on the way out.
 *
 * Every function is a read: one SELECT, positional `?` only, no `.pluck()` —
 * the same driver-agnostic shape the CLI's `node:sqlite` store can serve.
 */

export interface StageFirstPass {
  readonly stageKey: string;
  readonly advanced: number;
  readonly blocked: number;
  readonly stopped: number;
  /** Runs opened on attempt 0 — the ticket's first go at this stage. */
  readonly firstAttempts: number;
  readonly firstAttemptAdvanced: number;
  /** `firstAttemptAdvanced / firstAttempts`, `null` when the stage never ran. */
  readonly rate: number | null;
}

export interface FirstPassRate {
  readonly byStage: readonly StageFirstPass[];
  readonly overall: Omit<StageFirstPass, 'stageKey'>;
}

interface FirstPassRow {
  stage_key: string;
  advanced: number;
  blocked: number;
  stopped: number;
  first_attempts: number;
  first_advanced: number;
}

/**
 * How often a stage went green the first time it ran.
 *
 * `stage_runs.outcome` is the deterministic record ('advanced' | 'blocked' |
 * 'stopped'); a run still open (or gone stale) has a NULL outcome and is
 * counted in none of the three — an unfinished run is not a failure.
 */
export function firstPassRate(store: Store, scope: MetricsScope): FirstPassRate {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'sr.run_at',
  });
  const rows = store.db
    .prepare(
      `SELECT sr.stage_key AS stage_key,
              SUM(COALESCE(sr.outcome = 'advanced', 0)) AS advanced,
              SUM(COALESCE(sr.outcome = 'blocked', 0)) AS blocked,
              SUM(COALESCE(sr.outcome = 'stopped', 0)) AS stopped,
              SUM(COALESCE(sr.attempt = 0 AND sr.outcome IS NOT NULL, 0)) AS first_attempts,
              SUM(COALESCE(sr.attempt = 0 AND sr.outcome = 'advanced', 0)) AS first_advanced
         FROM stage_runs sr
         JOIN tickets t ON t.id = sr.ticket_id
        WHERE 1 = 1${clause}
        GROUP BY sr.stage_key
        ORDER BY sr.stage_key`,
    )
    .all(...params) as FirstPassRow[];

  const byStage = rows.map((r) => ({
    stageKey: r.stage_key,
    advanced: r.advanced,
    blocked: r.blocked,
    stopped: r.stopped,
    firstAttempts: r.first_attempts,
    firstAttemptAdvanced: r.first_advanced,
    rate: ratio(r.first_advanced, r.first_attempts),
  }));
  const total = (pick: (s: StageFirstPass) => number): number =>
    byStage.reduce((sum, s) => sum + pick(s), 0);
  const firstAttempts = total((s) => s.firstAttempts);
  const firstAttemptAdvanced = total((s) => s.firstAttemptAdvanced);
  return {
    byStage,
    overall: {
      advanced: total((s) => s.advanced),
      blocked: total((s) => s.blocked),
      stopped: total((s) => s.stopped),
      firstAttempts,
      firstAttemptAdvanced,
      rate: ratio(firstAttemptAdvanced, firstAttempts),
    },
  };
}

export interface CycleTime {
  readonly mergedTickets: number;
  readonly medianHours: number | null;
  readonly meanHours: number | null;
  readonly p90Hours: number | null;
}

/**
 * `tickets.created_at` → the LAST `prs.merged_at` across the ticket's repos.
 *
 * A ticket counts only once every PR it opened has merged is not knowable here
 * (the selected-repo set is a JSON column, and an unopened repo has no row), so
 * this is "created until the last merge that happened" — see the ticket-level
 * merge stamp listed under the known gaps.
 */
export function cycleTime(store: Store, scope: MetricsScope): CycleTime {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 't.created_at',
  });
  const rows = store.db
    .prepare(
      `SELECT t.created_at AS created_at, MAX(p.merged_at) AS merged_at
         FROM tickets t
         JOIN prs p ON p.ticket_id = t.id
        WHERE p.merged_at IS NOT NULL${clause}
        GROUP BY t.id`,
    )
    .all(...params) as { created_at: string; merged_at: string }[];

  const hours = rows
    .map((r) => (Date.parse(r.merged_at) - Date.parse(r.created_at)) / 3_600_000)
    .filter((h) => Number.isFinite(h));
  return {
    mergedTickets: hours.length,
    medianHours: percentile(hours, 0.5),
    meanHours: mean(hours),
    p90Hours: percentile(hours, 0.9),
  };
}

export interface EscapedDefects {
  readonly tickets: number;
  /** Tickets that name a parent — work that came back after the parent shipped. */
  readonly followUps: number;
  readonly parentsWithFollowUps: number;
  readonly rate: number | null;
}

/** Follow-up tickets (`tickets.parent_ticket_id`) as a share of all tickets. */
export function escapedDefects(store: Store, scope: MetricsScope): EscapedDefects {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 't.created_at',
  });
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS tickets,
              SUM(COALESCE(t.parent_ticket_id IS NOT NULL, 0)) AS follow_ups,
              COUNT(DISTINCT t.parent_ticket_id) AS parents
         FROM tickets t
        WHERE 1 = 1${clause}`,
    )
    .get(...params) as { tickets: number; follow_ups: number | null; parents: number };
  const followUps = row.follow_ups ?? 0;
  return {
    tickets: row.tickets,
    followUps,
    parentsWithFollowUps: row.parents,
    rate: ratio(followUps, row.tickets),
  };
}

export interface MergeFriction {
  readonly checks: number;
  readonly conflicted: number;
  readonly conflictRate: number | null;
  readonly byState: readonly { readonly state: string; readonly count: number }[];
}

/** How often the merge probe came back `conflicted` rather than clean. */
export function mergeFriction(store: Store, scope: MetricsScope): MergeFriction {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'm.checked_at',
  });
  const rows = store.db
    .prepare(
      `SELECT m.state AS state, COUNT(*) AS count
         FROM merge_checks m
         JOIN tickets t ON t.id = m.ticket_id
        WHERE 1 = 1${clause}
        GROUP BY m.state
        ORDER BY m.state`,
    )
    .all(...params) as { state: string; count: number }[];
  const checks = rows.reduce((sum, r) => sum + r.count, 0);
  const conflicted = rows.find((r) => r.state === 'conflicted')?.count ?? 0;
  return { checks, conflicted, conflictRate: ratio(conflicted, checks), byState: rows };
}

export interface ShipFailures {
  readonly steps: number;
  readonly failed: number;
  readonly failureRate: number | null;
  readonly byStep: readonly { readonly step: string; readonly failed: number }[];
}

/** Which ship step (`commit` | `push` | `describe` | `pr`) fails, and how often. */
export function shipFailures(store: Store, scope: MetricsScope): ShipFailures {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 's.started_at',
  });
  const rows = store.db
    .prepare(
      `SELECT s.step AS step,
              COUNT(*) AS count,
              SUM(COALESCE(s.status = 'failed', 0)) AS failed
         FROM ship_repo_steps s
         JOIN ship_runs r ON r.id = s.ship_run_id
         JOIN tickets t ON t.id = r.ticket_id
        WHERE 1 = 1${clause}
        GROUP BY s.step
        ORDER BY s.step`,
    )
    .all(...params) as { step: string; count: number; failed: number }[];
  const steps = rows.reduce((sum, r) => sum + r.count, 0);
  const failed = rows.reduce((sum, r) => sum + r.failed, 0);
  return {
    steps,
    failed,
    failureRate: ratio(failed, steps),
    byStep: rows.filter((r) => r.failed > 0).map((r) => ({ step: r.step, failed: r.failed })),
  };
}
