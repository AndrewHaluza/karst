/**
 * Entry-point matrix for graph tickets (Slice 3 Task 7).
 *
 * While a graph run is `planning`/`awaiting-confirmation`/`running`/
 * `draining`, the coordinator owns continuation and the generic session
 * surfaces must not spawn, adopt, nudge, or drive:
 *
 * | Entry point    | Behavior while a graph run is active                     |
 * |----------------|----------------------------------------------------------|
 * | openSession    | detects the active graph run BEFORE SessionManager and   |
 * |                | reveals the planner/node terminal from the transport     |
 * |                | registry — NEVER spawns                                  |
 * | nudge          | no-op; the coordinator owns continuation                 |
 * | adoptRevived   | adopts only terminals whose KARST_LAUNCH_ID matches a    |
 * |                | live node/planner run of the active graph; never launches|
 * | driveTicket    | not invoked for a graph ticket at impl                  |
 * | resumeFix      | unreachable at impl; belongs to fix                      |
 *
 * A run in `completed-awaiting-impl-marker` has no active work, so the
 * surfaces behave normally again — which is what makes the Inside "Complete
 * implementation" action usable beside a refreshed session.
 *
 * Stop is a coordinator-level controller, not `DriverController`: it
 * terminates every running node process through `AgentTransport.terminate`
 * and moves the graph run to `draining`, NEVER to `blocked`.
 *
 * Host-agnostic: store reads via the driver-agnostic `GraphDb`, transport and
 * clock injected.
 */

import type { GraphDb } from '../../store/graph/transitions.js';
import { GRAPH_RUN_TRANSITIONS, casStatus } from '../../store/graph/transitions.js';
import type { AgentTransport, SupervisedAgentSession } from './transport/supervisedCliTransport.js';

/** Graph run statuses in which the coordinator owns the ticket's surface. */
export const ACTIVE_GRAPH_STATUSES: ReadonlySet<string> = new Set([
  'planning',
  'awaiting-confirmation',
  'running',
  'draining',
]);

export type GraphTicketSurface = 'active-graph' | 'graph-marker' | 'none';

export interface GraphRunSurface {
  graphRunId: number;
  status: string;
}

/** The most recent graph run of a ticket in an active status, or undefined. */
export function activeGraphRunFor(db: GraphDb, ticketId: number): GraphRunSurface | undefined {
  const placeholders = [...ACTIVE_GRAPH_STATUSES].map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT id, status FROM approach_graph_runs
       WHERE ticket_id = ? AND status IN (${placeholders})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, ...ACTIVE_GRAPH_STATUSES) as { id: number; status: string } | undefined;
  return row ? { graphRunId: row.id, status: row.status } : undefined;
}

/** The openSession surface: active graph → reveal-only; a marker-ready run
 *  restores the normal surface. */
export function graphTicketSurface(db: GraphDb, ticketId: number): GraphTicketSurface {
  const run = activeGraphRunFor(db, ticketId);
  if (run) return 'active-graph';
  const markerReady = db
    .prepare(
      "SELECT 1 AS x FROM approach_graph_runs WHERE ticket_id = ? AND status = 'completed-awaiting-impl-marker' LIMIT 1",
    )
    .get(ticketId);
  return markerReady ? 'graph-marker' : 'none';
}

/** nudge: with an active graph run the coordinator owns continuation — the
 *  generic nudge is a no-op. */
export function nudgeSurface(db: GraphDb, ticketId: number): 'no-op' | 'nudge' {
  return activeGraphRunFor(db, ticketId) ? 'no-op' : 'nudge';
}

/** driveTicket: a graph ticket at impl with an active run is never driven by
 *  the stage driver — the coordinator drives. */
export function shouldDriveGraphTicket(db: GraphDb, ticketId: number): boolean {
  return !activeGraphRunFor(db, ticketId);
}

/**
 * adoption: while the graph is active, adopt only terminals whose
 * KARST_LAUNCH_ID matches a LIVE node/planner run of the active graph; a
 * stale run's terminal is refused, never adopted. No active graph → legacy.
 */
export function adoptionSurface(
  db: GraphDb,
  ticketId: number,
  launchId: string,
): 'adopt' | 'refuse' | 'legacy' {
  const run = activeGraphRunFor(db, ticketId);
  if (!run) return 'legacy';
  const runId = /^[1-9]\d*$/.test(launchId) ? Number(launchId) : NaN;
  if (!Number.isInteger(runId)) return 'refuse';
  const node = db
    .prepare(
      `SELECT 1 AS x FROM approach_node_runs
       WHERE id = ? AND graph_run_id = ?
         AND status NOT IN ('completed', 'stale', 'cancelled') LIMIT 1`,
    )
    .get(runId, run.graphRunId);
  if (node) return 'adopt';
  const planner = db
    .prepare(
      `SELECT 1 AS x FROM approach_planner_runs
       WHERE id = ? AND graph_run_id = ?
         AND status NOT IN ('submitted', 'stale', 'cancelled') LIMIT 1`,
    )
    .get(runId, run.graphRunId);
  return planner ? 'adopt' : 'refuse';
}

export interface StopActiveGraphDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing. */
  transaction: <T>(fn: () => T) => T;
  transport: AgentTransport;
  /** The active graph's sessions (the transport's own registry). */
  sessionsFor: (graphRunId: number) => SupervisedAgentSession[];
  debug?: (message: string) => void;
}

export interface StopActiveGraphResult {
  graphRunId: number;
  drained: boolean;
  terminated: number;
  refused: number;
}

/**
 * Stop: the coordinator-level controller. Terminates every running node
 * process of the active graph via the transport, then moves the graph run
 * `running → draining` — NEVER to `blocked`. A proof that is not a kill
 * (`denied`/`unknown`) is a refusal: the node row stays `running` and the
 * lease stays held; the caller maps it per the design's outcome table.
 */
export async function stopActiveGraph(
  deps: StopActiveGraphDeps,
  input: { ticketId: number; graphRunId: number },
): Promise<StopActiveGraphResult> {
  const sessions = deps.sessionsFor(input.graphRunId);
  let terminated = 0;
  let refused = 0;
  for (const session of sessions) {
    try {
      const proof = await deps.transport.terminate(session);
      if (proof.kind === 'attributable' && proof.kill === 'killed') {
        terminated += 1;
      } else {
        deps.debug?.(
          `[graph] stop: node ${session.nodeRunId} not terminated (${proof.kind}${proof.kind === 'attributable' ? `:${proof.kill}` : ''})`,
        );
        refused += 1;
      }
    } catch (err) {
      deps.debug?.(`[graph] stop: terminate failed for node ${session.nodeRunId}: ${String(err)}`);
      refused += 1;
    }
  }
  const drained = deps.transaction(() =>
    casStatus(
      deps.db,
      'approach_graph_runs',
      GRAPH_RUN_TRANSITIONS,
      input.graphRunId,
      'running',
      'draining',
    ),
  );
  return { graphRunId: input.graphRunId, drained, terminated, refused };
}
