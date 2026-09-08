import type { Store } from '../db.js';
import { ratio, scopeSql, type MetricsScope } from './scope.js';

/**
 * Quality-family effectiveness metrics: what the gates killed, how much rework
 * that cost, and how much the review gate actually caught before a human did.
 */

export interface GateBreakdown {
  readonly gateName: string;
  readonly runs: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** `exit_code IS NULL` — the repo defines no such script. NOT a pass. */
  readonly noScript: number;
}

export interface GateKillDistribution {
  readonly runs: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly noScript: number;
  readonly failureRate: number | null;
  readonly byGate: readonly GateBreakdown[];
  readonly byExitCode: readonly { readonly exitCode: number; readonly count: number }[];
}

/**
 * Which gate kills a stage, and how.
 *
 * The four buckets are deliberately disjoint and never collapsed: a skipped
 * gate (disabled for this ticket) and an absent script (`exit_code IS NULL`)
 * are different facts, and neither is a green run.
 */
export function gateKillDistribution(store: Store, scope: MetricsScope): GateKillDistribution {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'g.run_at',
  });
  const byGate = store.db
    .prepare(
      `SELECT g.gate_name AS gate_name,
              COUNT(*) AS runs,
              SUM(COALESCE(g.skipped IS NOT 1 AND g.exit_code = 0, 0)) AS passed,
              SUM(COALESCE(g.skipped IS NOT 1 AND g.exit_code > 0, 0)) AS failed,
              SUM(COALESCE(g.skipped = 1, 0)) AS skipped,
              SUM(COALESCE(g.skipped IS NOT 1 AND g.exit_code IS NULL, 0)) AS no_script
         FROM gate_runs g
         JOIN tickets t ON t.id = g.ticket_id
        WHERE 1 = 1${clause}
        GROUP BY g.gate_name
        ORDER BY g.gate_name`,
    )
    .all(...params) as {
    gate_name: string;
    runs: number;
    passed: number;
    failed: number;
    skipped: number;
    no_script: number;
  }[];

  const byExitCode = store.db
    .prepare(
      `SELECT g.exit_code AS exit_code, COUNT(*) AS count
         FROM gate_runs g
         JOIN tickets t ON t.id = g.ticket_id
        WHERE g.exit_code > 0 AND g.skipped IS NOT 1${clause}
        GROUP BY g.exit_code
        ORDER BY g.exit_code`,
    )
    .all(...params) as { exit_code: number; count: number }[];

  const rows = byGate.map((r) => ({
    gateName: r.gate_name,
    runs: r.runs,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    noScript: r.no_script,
  }));
  const sum = (pick: (g: GateBreakdown) => number): number =>
    rows.reduce((total, g) => total + pick(g), 0);
  const runs = sum((g) => g.runs);
  const failed = sum((g) => g.failed);
  return {
    runs,
    passed: sum((g) => g.passed),
    failed,
    skipped: sum((g) => g.skipped),
    noScript: sum((g) => g.noScript),
    failureRate: ratio(failed, runs),
    byGate: rows,
    byExitCode: byExitCode.map((r) => ({ exitCode: r.exit_code, count: r.count })),
  };
}

export interface ReworkLoops {
  readonly rounds: number;
  /** Distinct `(ticket, episode)` pairs — one recovery episode each. */
  readonly episodes: number;
  readonly exhaustedEpisodes: number;
  readonly maxRoundReached: number;
  readonly meanRoundsPerEpisode: number | null;
  readonly byStatus: readonly { readonly status: string; readonly count: number }[];
  readonly byTriggerKind: readonly { readonly triggerKind: string; readonly count: number }[];
}

/** How many fix→revalidate loops the workflow spent, and how many ran out. */
export function reworkLoops(store: Store, scope: MetricsScope): ReworkLoops {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'r.started_at',
  });
  const from = `FROM recovery_rounds r JOIN tickets t ON t.id = r.ticket_id WHERE 1 = 1${clause}`;
  const totals = store.db
    .prepare(
      `SELECT COUNT(*) AS rounds,
              COUNT(DISTINCT r.ticket_id || ':' || r.episode) AS episodes,
              COUNT(DISTINCT CASE WHEN r.status = 'exhausted'
                                  THEN r.ticket_id || ':' || r.episode END) AS exhausted,
              COALESCE(MAX(r.round), 0) AS max_round
         ${from}`,
    )
    .get(...params) as { rounds: number; episodes: number; exhausted: number; max_round: number };
  const byStatus = store.db
    .prepare(`SELECT r.status AS status, COUNT(*) AS count ${from} GROUP BY r.status ORDER BY r.status`)
    .all(...params) as { status: string; count: number }[];
  const byTriggerKind = store.db
    .prepare(
      `SELECT r.trigger_kind AS trigger_kind, COUNT(*) AS count ${from}
        GROUP BY r.trigger_kind ORDER BY r.trigger_kind`,
    )
    .all(...params) as { trigger_kind: string; count: number }[];

  return {
    rounds: totals.rounds,
    episodes: totals.episodes,
    exhaustedEpisodes: totals.exhausted,
    maxRoundReached: totals.max_round,
    meanRoundsPerEpisode: ratio(totals.rounds, totals.episodes),
    byStatus,
    byTriggerKind: byTriggerKind.map((r) => ({ triggerKind: r.trigger_kind, count: r.count })),
  };
}

export interface SeverityCounts {
  readonly total: number;
  readonly bySeverity: readonly { readonly severity: string; readonly count: number }[];
}

export interface FindingDensity {
  readonly review: SeverityCounts;
  readonly uat: SeverityCounts;
  /** Review + UAT findings per merged ticket; `null` when nothing has merged. */
  readonly perMergedTicket: number | null;
}

function severityCounts(
  store: Store,
  scope: MetricsScope,
  table: 'review_findings' | 'uat_findings',
): SeverityCounts {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'f.created_at',
  });
  const rows = store.db
    .prepare(
      `SELECT f.severity AS severity, COUNT(*) AS count
         FROM ${table} f
         JOIN tickets t ON t.id = f.ticket_id
        WHERE 1 = 1${clause}
        GROUP BY f.severity
        ORDER BY f.severity`,
    )
    .all(...params) as { severity: string; count: number }[];
  return { total: rows.reduce((sum, r) => sum + r.count, 0), bySeverity: rows };
}

/** Tickets that reached a merge — the denominator for per-ticket densities. */
function mergedTicketCount(store: Store, scope: MetricsScope): number {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 't.created_at',
  });
  const row = store.db
    .prepare(
      `SELECT COUNT(DISTINCT t.id) AS merged
         FROM tickets t
         JOIN prs p ON p.ticket_id = t.id
        WHERE p.merged_at IS NOT NULL${clause}`,
    )
    .get(...params) as { merged: number };
  return row.merged;
}

/** How many findings the two finding-producing gates raised, by severity. */
export function findingDensity(store: Store, scope: MetricsScope): FindingDensity {
  const review = severityCounts(store, scope, 'review_findings');
  const uat = severityCounts(store, scope, 'uat_findings');
  return {
    review,
    uat,
    perMergedTicket: ratio(review.total + uat.total, mergedTicketCount(store, scope)),
  };
}

export interface FindingSourceSplit {
  readonly total: number;
  readonly agent: number;
  readonly human: number;
  /**
   * The share a human raised. The sharpest single signal here: findings the
   * review gate missed are what a human had to catch, so this measures the
   * gate's real value without needing a control arm.
   */
  readonly humanShare: number | null;
  readonly bySource: readonly { readonly source: string; readonly count: number }[];
}

/** `review_findings.source` — agent-raised versus human-raised. */
export function findingSourceSplit(store: Store, scope: MetricsScope): FindingSourceSplit {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'f.created_at',
  });
  const rows = store.db
    .prepare(
      `SELECT f.source AS source, COUNT(*) AS count
         FROM review_findings f
         JOIN tickets t ON t.id = f.ticket_id
        WHERE 1 = 1${clause}
        GROUP BY f.source
        ORDER BY f.source`,
    )
    .all(...params) as { source: string; count: number }[];
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const human = rows.find((r) => r.source === 'human')?.count ?? 0;
  return {
    total,
    agent: rows.find((r) => r.source === 'agent')?.count ?? 0,
    human,
    humanShare: ratio(human, total),
    bySource: rows,
  };
}

export interface Interruptions {
  readonly processRuns: number;
  readonly interruptedProcessRuns: number;
  readonly interruptRate: number | null;
  /** Summed `recovery_rounds.interrupt_count` — interrupts inside a fix loop. */
  readonly recoveryInterrupts: number;
}

/** How often a run was interrupted rather than reaching a verdict of its own. */
export function interruptions(store: Store, scope: MetricsScope): Interruptions {
  const runScope = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'pr.started_at',
  });
  const runs = store.db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(COALESCE(pr.status = 'interrupted', 0)) AS interrupted
         FROM process_runs pr
         JOIN tickets t ON t.id = pr.ticket_id
        WHERE 1 = 1${runScope.clause}`,
    )
    .get(...runScope.params) as { total: number; interrupted: number | null };

  const recoveryScope = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'r.started_at',
  });
  const recovery = store.db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(r.interrupt_count, 0)), 0) AS interrupts
         FROM recovery_rounds r
         JOIN tickets t ON t.id = r.ticket_id
        WHERE 1 = 1${recoveryScope.clause}`,
    )
    .get(...recoveryScope.params) as { interrupts: number };

  const interrupted = runs.interrupted ?? 0;
  return {
    processRuns: runs.total,
    interruptedProcessRuns: interrupted,
    interruptRate: ratio(interrupted, runs.total),
    recoveryInterrupts: recovery.interrupts,
  };
}
