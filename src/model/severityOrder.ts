import type { Severity } from '../manifest/types.js';

/**
 * Worst-first rank for the five-level finding vocabulary. Lower number =
 * worse. Shared by the inside evidence reducers and the artifacts reducer
 * so a findings list reads in the same order wherever it is rendered.
 *
 * The workflow-side rank maps (`workflow/review/findings.ts`,
 * `workflow/review/aggregate.ts`, `model/inside/ship.ts`) are deliberately
 * NOT consolidated here: they gate verdicts, and a shared mutable-looking
 * import across the verdict path is a coupling this module does not want.
 */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Sort worst-first, STABLE within a rank. Report order is the order an
 * agent chose to report in and carries meaning; only the rank overrides
 * it. Returns a new array — the input is never mutated.
 *
 * A row whose severity is not in the vocabulary sorts LAST (rank 5),
 * never silently as `low`: an unrecognised level is absence of a level.
 */
export function sortBySeverityDesc<T extends { severity: string }>(
  rows: readonly T[],
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ra = SEVERITY_RANK[a.row.severity as Severity] ?? 5;
      const rb = SEVERITY_RANK[b.row.severity as Severity] ?? 5;
      return ra === rb ? a.index - b.index : ra - rb;
    })
    .map((entry) => entry.row);
}
