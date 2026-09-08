import type { Store } from '../db.js';
import { ratio, scopeSql, type MetricsScope } from './scope.js';

/**
 * Cost-family effectiveness metrics: what the orchestration spent — tokens at
 * the metering seam, wall clock with an agent attached, and how much of the
 * graph runtime went into replanning rather than into nodes.
 */

export interface TokenGroup {
  readonly calls: number;
  readonly reportedTokens: number;
  readonly estimatedTokens: number;
}

export interface TokenBurn extends TokenGroup {
  readonly byCallSite: readonly (TokenGroup & { readonly callSite: string })[];
  readonly byProvider: readonly (TokenGroup & { readonly provider: string | null })[];
  readonly byModel: readonly (TokenGroup & { readonly model: string | null })[];
  readonly mergedTickets: number;
  /**
   * REPORTED tokens per merged ticket. Estimated rows are deliberately left
   * out of this number and reported beside it — an approximation must never be
   * presented as measured spend.
   */
  readonly perMergedTicket: number | null;
}

interface TokenRow {
  bucket: string | null;
  calls: number;
  reported: number;
  estimated: number;
}

function toGroup(row: TokenRow): TokenGroup {
  return { calls: row.calls, reportedTokens: row.reported, estimatedTokens: row.estimated };
}

function tokensBy(store: Store, scope: MetricsScope, column: string): TokenRow[] {
  // Scoped on `token_usage.project_id`, not the ticket's: a call made while the
  // ticket was still an unsaved draft has no ticket_id but is real spend.
  const { clause, params } = scopeSql(scope, {
    projectColumn: 'u.project_id',
    sinceColumn: 'u.recorded_at',
  });
  return store.db
    .prepare(
      `SELECT ${column} AS bucket,
              COUNT(*) AS calls,
              SUM(COALESCE(CASE WHEN u.estimated = 1 THEN 0 ELSE u.total_tokens END, 0)) AS reported,
              SUM(COALESCE(CASE WHEN u.estimated = 1 THEN u.total_tokens ELSE 0 END, 0)) AS estimated
         FROM token_usage u
        WHERE 1 = 1${clause}
        ${column === '1' ? '' : `GROUP BY ${column} ORDER BY ${column}`}`,
    )
    .all(...params) as TokenRow[];
}

/** Token spend, split by where it was spent and whether it was measured. */
export function tokenBurn(store: Store, scope: MetricsScope): TokenBurn {
  const byCallSite = tokensBy(store, scope, 'u.call_site');
  const byProvider = tokensBy(store, scope, 'u.provider');
  const byModel = tokensBy(store, scope, 'u.model');
  const sum = (pick: (r: TokenRow) => number): number =>
    byCallSite.reduce((total, r) => total + pick(r), 0);
  const reportedTokens = sum((r) => r.reported);

  const ticketScope = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 't.created_at',
  });
  const merged = store.db
    .prepare(
      `SELECT COUNT(DISTINCT t.id) AS merged
         FROM tickets t
         JOIN prs p ON p.ticket_id = t.id
        WHERE p.merged_at IS NOT NULL${ticketScope.clause}`,
    )
    .get(...ticketScope.params) as { merged: number };

  return {
    calls: sum((r) => r.calls),
    reportedTokens,
    estimatedTokens: sum((r) => r.estimated),
    byCallSite: byCallSite.map((r) => ({ callSite: r.bucket ?? 'unknown', ...toGroup(r) })),
    byProvider: byProvider.map((r) => ({ provider: r.bucket, ...toGroup(r) })),
    byModel: byModel.map((r) => ({ model: r.bucket, ...toGroup(r) })),
    mergedTickets: merged.merged,
    perMergedTicket: ratio(reportedTokens, merged.merged),
  };
}

export interface AgentActiveTime {
  readonly processRunHours: number;
  readonly implementationRunHours: number;
  /** Runs with no `ended_at`: still open, or killed without a closing stamp. */
  readonly openRuns: number;
}

function summedHours(
  store: Store,
  scope: MetricsScope,
  table: 'process_runs' | 'implementation_runs',
): { hours: number; open: number } {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'r.started_at',
  });
  const rows = store.db
    .prepare(
      `SELECT r.started_at AS started_at, r.ended_at AS ended_at
         FROM ${table} r
         JOIN tickets t ON t.id = r.ticket_id
        WHERE 1 = 1${clause}`,
    )
    .all(...params) as { started_at: string; ended_at: string | null }[];
  let hours = 0;
  let open = 0;
  for (const row of rows) {
    if (row.ended_at === null) {
      open += 1;
      continue;
    }
    const span = (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 3_600_000;
    if (Number.isFinite(span) && span > 0) hours += span;
  }
  return { hours, open };
}

/**
 * Wall clock with an agent attached. Computed in JS from the ISO stamps rather
 * than with `julianday`, so the answer does not depend on which SQLite build
 * (better-sqlite3 or `node:sqlite`) served the query.
 */
export function agentActiveTime(store: Store, scope: MetricsScope): AgentActiveTime {
  const processRuns = summedHours(store, scope, 'process_runs');
  const implementationRuns = summedHours(store, scope, 'implementation_runs');
  return {
    processRunHours: processRuns.hours,
    implementationRunHours: implementationRuns.hours,
    openRuns: processRuns.open + implementationRuns.open,
  };
}

export interface GraphEfficiency {
  readonly graphRuns: number;
  readonly nodeRuns: number;
  readonly replans: number;
  readonly replansPerNodeRun: number | null;
  readonly byFailureCategory: readonly {
    readonly failureCategory: string;
    readonly count: number;
  }[];
}

/** How much of a graph approach's work went into replanning, and why nodes failed. */
export function graphEfficiency(store: Store, scope: MetricsScope): GraphEfficiency {
  const { clause, params } = scopeSql(scope, {
    projectColumn: 't.project_id',
    sinceColumn: 'g.created_at',
  });
  const totals = store.db
    .prepare(
      `SELECT COUNT(*) AS graph_runs,
              SUM(COALESCE(g.node_run_count, 0)) AS node_runs,
              SUM(COALESCE(g.replan_count, 0)) AS replans
         FROM approach_graph_runs g
         JOIN tickets t ON t.id = g.ticket_id
        WHERE 1 = 1${clause}`,
    )
    .get(...params) as { graph_runs: number; node_runs: number | null; replans: number | null };

  const categories = store.db
    .prepare(
      `SELECT n.failure_category AS failure_category, COUNT(*) AS count
         FROM approach_node_runs n
         JOIN approach_graph_runs g ON g.id = n.graph_run_id
         JOIN tickets t ON t.id = g.ticket_id
        WHERE n.failure_category IS NOT NULL${clause}
        GROUP BY n.failure_category
        ORDER BY n.failure_category`,
    )
    .all(...params) as { failure_category: string; count: number }[];

  const nodeRuns = totals.node_runs ?? 0;
  const replans = totals.replans ?? 0;
  return {
    graphRuns: totals.graph_runs,
    nodeRuns,
    replans,
    replansPerNodeRun: ratio(replans, nodeRuns),
    byFailureCategory: categories.map((r) => ({
      failureCategory: r.failure_category,
      count: r.count,
    })),
  };
}
