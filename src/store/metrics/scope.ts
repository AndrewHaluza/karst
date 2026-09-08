/**
 * Scoping shared by every effectiveness metric.
 *
 * Two dimensions, and only two: the project a ticket belongs to, and a cutoff
 * on the timestamp column that is meaningful for THAT metric (a gate run cuts
 * on `gate_runs.run_at`, a token row on `token_usage.recorded_at`). There is no
 * single clock in the store, so the column is named per query rather than
 * guessed here.
 */

export interface MetricsScope {
  /** `tickets.project_id` to restrict to; omitted = every project in the file. */
  readonly projectId?: number;
  /** ISO timestamp; rows stamped strictly before it are excluded. */
  readonly since?: string;
}

export type SqlParam = string | number;

export interface ScopeSql {
  /** Always starts with ` AND `, so callers open with `WHERE 1 = 1`. */
  readonly clause: string;
  readonly params: readonly SqlParam[];
}

/**
 * Render the scope as a SQL fragment.
 *
 * `projectColumn` is the qualified `project_id` reachable from the query (the
 * tickets row it joins). `sinceColumn` is the qualified timestamp this metric
 * cuts on — omit it when the table carries no timestamp of its own and the
 * cutoff has to ride on the ticket instead.
 */
export function scopeSql(
  scope: MetricsScope,
  columns: { readonly projectColumn: string; readonly sinceColumn?: string },
): ScopeSql {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  if (scope.projectId !== undefined) {
    parts.push(` AND ${columns.projectColumn} = ?`);
    params.push(scope.projectId);
  }
  if (scope.since !== undefined && columns.sinceColumn !== undefined) {
    parts.push(` AND ${columns.sinceColumn} >= ?`);
    params.push(scope.since);
  }
  return { clause: parts.join(''), params };
}

/** `x / y`, or `null` when there is nothing to divide — never a fabricated 0. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Percentile (linear interpolation) of an unsorted sample, `null` when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** Arithmetic mean, `null` when empty. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
