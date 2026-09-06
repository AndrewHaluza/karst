/**
 * Entry-point matrix for graph tickets (Slice 3 Task 7).
 *
 * While a graph run is `planning`/`awaiting-confirmation`/`running`/
 * `draining`/`completed-awaiting-impl-marker`, the coordinator owns
 * continuation and the generic session
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
 * A run in `completed-awaiting-impl-marker` stays on the graph surface: its
 * work is complete, but only the graph marker guard may advance the ticket.
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
import type { ProcessFactsSource } from '../../runtime/serverIdentity.js';
import { graphRunHasLiveNodeProcess } from './coordinator/liveness.js';
import { hasLiveReplanPlanner } from '../../store/graph/plannerRuns.js';

/** Graph run statuses in which the coordinator owns the ticket's surface. */
export const ACTIVE_GRAPH_STATUSES: ReadonlySet<string> = new Set([
  'planning',
  'awaiting-confirmation',
  'running',
  'draining',
  'completed-awaiting-impl-marker',
]);

/** Statuses whose recorded sessions Stop may terminate. `blocked` deliberately
 * stays out of `ACTIVE_GRAPH_STATUSES`: it is not runnable, but remaining
 * processes may still need an explicit non-advancing stop. */
const STOPPABLE_GRAPH_STATUSES: ReadonlySet<string> = new Set([
  ...ACTIVE_GRAPH_STATUSES,
  'blocked',
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

/** The named graph run (or, for legacy callers, newest one) whose sessions Stop may terminate. */
export function stoppableGraphRunFor(
  db: GraphDb,
  ticketId: number,
  graphRunId?: number,
): GraphRunSurface | undefined {
  const placeholders = [...STOPPABLE_GRAPH_STATUSES].map(() => '?').join(', ');
  const exactRun = graphRunId === undefined ? '' : 'AND id = ?';
  const row = db
    .prepare(
      `SELECT id, status FROM approach_graph_runs
       WHERE ticket_id = ? ${exactRun} AND status IN (${placeholders})
       ORDER BY id DESC LIMIT 1`,
    )
    .get(
      ticketId,
      ...(graphRunId === undefined ? [] : [graphRunId]),
      ...STOPPABLE_GRAPH_STATUSES,
    ) as { id: number; status: string } | undefined;
  return row ? { graphRunId: row.id, status: row.status } : undefined;
}

/** The openSession surface: an active graph remains graph-owned, including
 *  while the implementation marker is awaited. */
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
  /** The active graph's sessions (the transport's own registry) — this
   *  WINDOW's in-memory bookkeeping, empty after a reload and in every other
   *  window, which is why it is never the only thing Stop consults. */
  sessionsFor: (graphRunId: number) => SupervisedAgentSession[];
  /** OS process probes (`runtime/serverIdentity.ts`) — the durable evidence
   *  behind "is anything of this run still alive". */
  facts: ProcessFactsSource;
  debug?: (message: string) => void;
}

/**
 * What Stop actually did — never a claim it did not earn.
 *  - `drained`: the run moved `running → draining`;
 *  - `live-process-unreachable`: this window observed no session, but a node
 *    run's recorded pid is alive — the run is left `running`;
 *  - `not-running`: the run was not `running` when the CAS ran (already
 *    draining, blocked, or moved by another window).
 */
export type StopOutcome = 'drained' | 'live-process-unreachable' | 'not-running';

export interface StopActiveGraphResult {
  graphRunId: number;
  drained: boolean;
  terminated: number;
  refused: number;
  outcome: StopOutcome;
}

/**
 * Stop: the coordinator-level controller. Terminates every running node
 * process of the active graph via the transport, then moves the graph run
 * `running → draining` — NEVER to `blocked`. A proof that is not a kill
 * (`denied`/`unknown`) is a refusal: the node row stays `running` and the
 * lease stays held; the caller maps it per the design's outcome table.
 *
 * The drain is CONDITIONAL on Stop having actually reached the run's work.
 * `sessionsFor` is this window's in-memory transport registry: after a reload,
 * and from every other window, a genuinely running graph's sessions are
 * invisible. `draining` is a state no sweep revisits — `reconcileGraphRun`
 * returns a no-op for any run that is not `running`, and the only
 * `draining → running` path is replan acceptance, which a plain Stop never
 * fires — so draining a run whose processes were NOT reached strands it
 * forever behind a `drained: true` that never happened. So when no session was
 * observed, Stop asks the durable question instead ("does any node run carry a
 * pid the OS says is alive"): alive → refuse to drain and say so, leaving the
 * run `running` where the sweep and a Stop from the owning window can still
 * reach it; nothing alive → there is no work left to strand and the drain is
 * honest.
 */
export type RestartOutcome = 'restarted' | 'not-draining' | 'replan-in-flight' | 'raced';

export interface RestartStoppedGraphResult {
  graphRunId: number;
  restarted: boolean;
  outcome: RestartOutcome;
}

/**
 * H2 — the exit Stop never had. `draining` has exactly ONE productive exit, an
 * accepted replan submission, and Stop enters it without electing a replan: no
 * sweep, no reconcile branch and no user action could move the run again, so
 * every Stop permanently stranded its ticket's graph.
 *
 * The restart is a plain `draining → running`: Stop leaves the revision
 * `active` (it never touches it), so the plan the run was executing is intact
 * and nothing needs recompiling. It is REFUSED for a run draining because a
 * replan planner still owes it a submission — that run is mid-replan, the
 * coordinator owns its exit, and restarting would race the submission it is
 * waiting for.
 *
 * Deliberate by construction: the caller is a click. A Stop is a considered
 * halt, and nothing here ever fires from a sweep.
 */
export function restartStoppedGraph(
  deps: Pick<StopActiveGraphDeps, 'db' | 'transaction' | 'debug'>,
  input: { ticketId: number; graphRunId: number },
): RestartStoppedGraphResult {
  const run = deps.db
    .prepare('SELECT status FROM approach_graph_runs WHERE id = ? AND ticket_id = ?')
    .get(input.graphRunId, input.ticketId) as { status: string } | undefined;
  if (run?.status !== 'draining') {
    return { graphRunId: input.graphRunId, restarted: false, outcome: 'not-draining' };
  }
  if (hasLiveReplanPlanner(deps.db, input.graphRunId)) {
    deps.debug?.(
      `[graph] restart: run ${input.graphRunId} is draining for a replan planner — refused`,
    );
    return { graphRunId: input.graphRunId, restarted: false, outcome: 'replan-in-flight' };
  }
  const restarted = deps.transaction(() =>
    casStatus(
      deps.db,
      'approach_graph_runs',
      GRAPH_RUN_TRANSITIONS,
      input.graphRunId,
      'draining',
      'running',
    ),
  );
  deps.debug?.(
    restarted
      ? `[graph] restart: run ${input.graphRunId} draining → running (stopped drain resumed on its active revision)`
      : `[graph] restart: run ${input.graphRunId} left draining under us — no-op`,
  );
  return {
    graphRunId: input.graphRunId,
    restarted,
    outcome: restarted ? 'restarted' : 'raced',
  };
}

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
  if (sessions.length === 0 && (await graphRunHasLiveNodeProcess(deps.db, deps.facts, input.graphRunId, deps.debug))) {
    deps.debug?.(
      `[graph] stop: run ${input.graphRunId} has a live node process this window cannot reach — not drained`,
    );
    return {
      graphRunId: input.graphRunId,
      drained: false,
      terminated,
      refused,
      outcome: 'live-process-unreachable',
    };
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
  return {
    graphRunId: input.graphRunId,
    drained,
    terminated,
    refused,
    outcome: drained ? 'drained' : 'not-running',
  };
}
