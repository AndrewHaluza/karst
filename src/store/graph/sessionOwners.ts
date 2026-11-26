/**
 * Graph-session owner reads (T1370): which ticket, and which provider, a graph
 * planner or node session belongs to. The hook dispatcher reads them to route
 * a graph session's `UsageUpdate` to the ledger. A graph session is not the
 * ticket's own session, so the ticket worktree lookup and the ticket provider
 * do not apply to it.
 *
 * Only an OPEN graph run owns a session: a closed, cancelled or stale run owns
 * nothing. Driver-agnostic (positional `?` only).
 */

import type { GraphDb } from './transitions.js';

/** The graph run statuses that own no live session. */
const CLOSED_GRAPH_RUN_STATUSES = ['closed', 'cancelled', 'stale'] as const;
const CLOSED_PLACEHOLDERS = CLOSED_GRAPH_RUN_STATUSES.map(() => '?').join(', ');

/** Which run table a graph launch names. */
export type GraphSessionRole = 'planner' | 'node';

const RUN_TABLE: Record<GraphSessionRole, string> = {
  planner: 'approach_planner_runs',
  node: 'approach_node_runs',
};

export interface GraphLaunchOwner {
  ticketId: number;
  graphRunId: number;
  runId: number;
  role: GraphSessionRole;
  /**
   * The provider of the run's RUNNING `process_runs` row. Null when the run
   * has no process run or the process run is closed: the session then owns no
   * spend, and the caller records nothing.
   */
  provider: string | null;
}

/**
 * The owner of a graph launch: the run must exist in the table its role names,
 * belong to the named graph run, and that graph run must be open. With a
 * `generation` (the secret part of a hook launch id) the run's persisted
 * generation must also equal it. Null otherwise — a launch id that only
 * matches the pattern proves nothing.
 */
export function graphLaunchOwner(
  db: GraphDb,
  launch: { graphRunId: number; runId: number; role: GraphSessionRole; generation?: string },
): GraphLaunchOwner | null {
  const generationClause = launch.generation === undefined ? '' : 'AND ar.generation = ?';
  const generationArgs = launch.generation === undefined ? [] : [launch.generation];
  const row = db
    .prepare(
      `SELECT gr.ticket_id AS ticket_id, pr.provider AS provider
         FROM ${RUN_TABLE[launch.role]} ar
         JOIN approach_graph_runs gr ON gr.id = ar.graph_run_id
         LEFT JOIN process_runs pr
           ON pr.id = ar.process_run_id
          AND pr.ticket_id = gr.ticket_id
          AND pr.status = 'running'
        WHERE ar.id = ? AND ar.graph_run_id = ? ${generationClause}
          AND gr.status NOT IN (${CLOSED_PLACEHOLDERS})`,
    )
    .get(launch.runId, launch.graphRunId, ...generationArgs, ...CLOSED_GRAPH_RUN_STATUSES) as
    | { ticket_id: number; provider: string | null }
    | undefined;
  if (row === undefined) return null;
  return {
    ticketId: row.ticket_id,
    graphRunId: launch.graphRunId,
    runId: launch.runId,
    role: launch.role,
    provider: row.provider,
  };
}

export interface GraphWorkspaceOwner {
  ticketId: number;
  graphRunId: number;
  nodeRunId: number;
  /** The cwd as the workspace ledger recorded it. */
  cwd: string;
}

/**
 * The node workspace a cwd names, of an open graph run. `canonical` maps both
 * sides to one form (the caller injects the realpath form; the store does no
 * fs work). The ledger holds a row only while a workspace is on disk, so the
 * scan is small.
 */
export function graphWorkspaceForCwd(
  db: GraphDb,
  cwd: string,
  canonical: (path: string) => string = (path) => path,
): GraphWorkspaceOwner | null {
  const rows = db
    .prepare(
      `SELECT gr.ticket_id AS ticketId, w.graph_run_id AS graphRunId,
              w.node_run_id AS nodeRunId, w.cwd AS cwd
         FROM approach_graph_workspaces w
         JOIN approach_graph_runs gr ON gr.id = w.graph_run_id
        WHERE gr.status NOT IN (${CLOSED_PLACEHOLDERS})
        ORDER BY w.id DESC`,
    )
    .all(...CLOSED_GRAPH_RUN_STATUSES) as GraphWorkspaceOwner[];
  const want = canonical(cwd);
  return rows.find((row) => canonical(row.cwd) === want) ?? null;
}
