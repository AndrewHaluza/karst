/**
 * The reconcile pass's run listing (G1b).
 *
 * `reconcileGraphRuns` (extension.ts) walks every `approach_graph_runs` row
 * and reconciles it, driving continuation for each. Two gaps made that a
 * cross-window contamination hazard identical to G1a's:
 *
 *  - no project scope: `approach_graph_runs` carries no `project_id` of its
 *    own (`docs/arch/store-and-schema.md`), so an unscoped listing reconciles
 *    every OTHER project's runs too. A window on project B then compiles
 *    project A's plan against B's manifest — the concrete failure this fixes
 *    is `unknown-repository: "extention"`, a repository declared in A's
 *    manifest but absent from B's;
 *  - no status filter: a `closed` run has nothing left to reconcile (its
 *    transition map, `GRAPH_RUN_TRANSITIONS`, has an EMPTY exit list — it is
 *    terminal by construction) and driving its continuation is dead work at
 *    best.
 *
 * `NON_TERMINAL_GRAPH_RUN_STATUSES` is derived from `GRAPH_RUN_TRANSITIONS`
 * (the authoritative status set, `store/graph/transitions.ts`): every status
 * with a non-empty exit list. `draining` MUST stay in this list — it is the
 * one status nothing else ever leaves (commit 2f7f741); a replan planner
 * working at `draining` has no crash-matrix branch anywhere else, so
 * excluding it here would silently reintroduce that stall.
 *
 * Host-agnostic: takes a `GraphDb`, returns run ids. No vscode, no provider.
 */

import { GRAPH_RUN_TRANSITIONS, type GraphDb } from '../../../store/graph/transitions.js';

/** Every graph-run status whose transition map has at least one exit —
 *  i.e. every status that is not terminal (`closed`, `stale`, `cancelled`). */
export const NON_TERMINAL_GRAPH_RUN_STATUSES: readonly string[] = Object.entries(
  GRAPH_RUN_TRANSITIONS,
).filter(([, exits]) => exits.length > 0).map(([status]) => status);

export interface ReconcilableGraphRunsScope {
  projectId: number;
}

/**
 * Graph run ids eligible for a reconcile pass: scoped to one project's
 * tickets, filtered to non-terminal statuses, oldest first (stable order for
 * the pass's own transitions log).
 */
export function reconcilableGraphRunIds(
  db: GraphDb,
  scope: ReconcilableGraphRunsScope,
  debug?: (message: string) => void,
): number[] {
  const placeholders = NON_TERMINAL_GRAPH_RUN_STATUSES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT r.id AS id
         FROM approach_graph_runs r
         JOIN tickets t ON t.id = r.ticket_id
        WHERE t.project_id = ? AND r.status IN (${placeholders})
        ORDER BY r.id`,
    )
    .all(scope.projectId, ...NON_TERMINAL_GRAPH_RUN_STATUSES) as { id: number }[];
  // The scope is where a project-scoping bug hides in plain sight: a tick that
  // reconciles NOTHING and a tick whose window holds the wrong project read
  // identically from the outside (G1 of the reliability audit was exactly
  // this). Naming the project and the ids it produced makes them different.
  debug?.(
    `[graph] reconcile scope: project ${scope.projectId} → ${rows.length} non-terminal run(s)` +
      (rows.length > 0 ? ` [${rows.map((r) => r.id).join(', ')}]` : ''),
  );
  return rows.map((r) => r.id);
}
