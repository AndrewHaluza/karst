/**
 * Reload and crash matrix (Slice 4 Task 3).
 *
 * `reconcileGraphRun` is the reload-time sweep: one pass over a graph run that
 * applies the design's crash matrix ("Reload, Multi-Window, and Stale Process
 * Recovery"). It runs once at activation, next to the coordinator sweep, and
 * decides purely from durable state + injected process facts — never from
 * "this window cannot see the terminal".
 *
 * Order is load-bearing:
 *
 *  1. ticket still at `impl`? If not, pending tokens are cancelled and the
 *     run is cancelled (no new claims) WITHOUT rewriting completed evidence;
 *  2. successor-run staleness: a non-terminal run is marked `stale` when a
 *     later run for the same ticket exists (the earlier host died) — a run
 *     with a live process anywhere is left strictly alone;
 *  3. run-level: `blocked` stays, `completed-awaiting-impl-marker` stays, a
 *     draining revision waits for its active work (the replan machinery owns
 *     the continuation) — but a draining RUN whose replan planner died is
 *     revived first (2.6), because nothing else ever leaves `draining`;
 *  4. node-level sweep per the matrix: `launching` (an owner nonce with no
 *     process proves a pre-spawn crash → retryable park; NO owner nonce and no
 *     process is the recovery-rearmed retry shape, left strictly alone for the
 *     driver's periodic relaunch; a process whose death is unprovable →
 *     `launch-unknown`), `running`
 *     (dead → `stale` + recoverable block; unprovable → `termination-unknown`
 *     with leases marked `ambiguous-process`; live attributable → left alone),
 *     and
 *     `completing`/`integrating` (dead → resume the completion pipeline where
 *     it stopped — the reported outcome is in hand and is never re-executed;
 *     live attributable → revert to `running` so completion proceeds).
 *
 * Window semantics: completion writes are window-agnostic by design — there
 * is no window field in any conditional UPDATE. "Wrong-window" applies solely
 * to loopback routing identity; multiple windows may reconcile concurrently
 * because every mutation is a durable conditional claim (CAS), and a raced
 * transition reads `false` and is skipped, never thrown.
 *
 * Host-agnostic: db, transaction, clock, process facts, the transport session
 * registry (`sessionFor`) and the completion-pipeline callback are injected;
 * no vscode, no provider, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, NODE_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import {
  graphRunIdTicketStatus,
  graphRunStatus,
  markGraphRunBlocked,
  nextGraphRunIdForTicketAfter,
  touchGraphRun,
} from '../../../store/graph/graphRuns.js';
import {
  nodeRunIdsForGraphRun,
  nodeRunsForGraphRun,
  setNodeRunReason,
} from '../../../store/graph/nodeRuns.js';
import { cancelGraphToken } from '../../../store/graph/tokens.js';
import {
  countReplanPlannersForTarget,
  latestPlannerRunForGraphRunKind,
  latestReplanPlannerForTarget,
  plannerRunCompileAttempt,
  transitionPlannerRun,
} from '../../../store/graph/plannerRuns.js';
import type { GraphRunRow as FullGraphRunRow } from '../../../store/graph/graphRuns.js';
import type { NodeRunRow as FullNodeRunRow } from '../../../store/graph/nodeRuns.js';
import type { PlannerRunRow as FullPlannerRunRow } from '../../../store/graph/plannerRuns.js';
import { markLeaseAmbiguous } from './leases.js';
import { cancelNodeRuns, type AbandonedNodeRun } from './abandonedNodes.js';
import { ACTIVE_NODE_STATUSES } from './completion.js';
import { graphRunHasLiveNodeProcess } from './liveness.js';
import { MAX_COMPILE_ATTEMPTS } from './repair.js';
import {
  attributeServer,
  type Attribution,
  type ProcessFactsSource,
} from '../../../runtime/serverIdentity.js';

/** Run statuses a later run for the same ticket supersedes. The marker-ready
 *  status is deliberately excluded: it holds completed evidence and stays
 *  awaiting the explicit marker (matrix row). */
const SUPERSEDABLE_RUN_STATUSES = [
  'planning',
  'awaiting-confirmation',
  'running',
  'draining',
  'blocked',
] as const;

/** Run statuses a ticket that left `impl` may cancel from. */
const CANCELLABLE_RUN_STATUSES = SUPERSEDABLE_RUN_STATUSES;

/** How many times a `ready` (allocated-but-never-launched) replan planner may
 *  be replaced before reconcile stops re-driving it. Bounds the row stream when
 *  a launch keeps failing before its `ready → launching` CAS (e.g. the launch
 *  worktree cannot be resolved). */
const MAX_REPLAN_LAUNCH_ATTEMPTS = 3;

export interface ReconcileGraphRunDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  /** OS process probes (`runtime/serverIdentity.ts`), injected for tests. */
  facts: ProcessFactsSource;
  /** The transport's session for a node run in THIS window; undefined after a
   *  reload. A session present means this window owns a live process. */
  sessionFor: (nodeRunId: number) => { pid: number | null } | undefined;
  /** Resume the completion pipeline for a node whose process is proven dead —
   *  the host wires this to `runCompletionPipeline`. Reconcile only hands the
   *  node over; it never re-executes the reported outcome itself. */
  resumePipeline: (nodeRunId: number) => void;
  /** Relaunch a planning run's bootstrap planner whose session is demonstrably
   *  gone — the host binds this to the driver's `relaunchBootstrapPlanner`
   *  (+ session registration). Reconcile only decides; it never launches. */
  relaunchPlanner: (graphRunId: number) => void;
  /** Relaunch a DRAINING run's replan planner whose session is demonstrably
   *  gone. Separate seam from `relaunchPlanner` because the two launch
   *  different things: a bootstrap planner plans the first revision, a replan
   *  planner compiles the next one onto a run that is already draining. */
  relaunchReplanPlanner: (graphRunId: number) => void;
  /** Re-prompt a bootstrap planner run stuck `blocked` awaiting its compile
   *  repair re-prompt (G2's fire-once launch never happened, or died between
   *  the transaction and the spawn). The host binds this to
   *  `launchPlannerRepairHost`; the actual single-flight claim is the SAME
   *  `blocked → launching` CAS the live accept-path launch already performs
   *  (`claimPlannerLaunch`), so firing this twice concurrently is safe — the
   *  loser's launch reports `already moved`. `attempt` is the planner run's
   *  current durable `compile_attempt` (the next re-prompt is attempt + 1). */
  relaunchCompileRepair: (graphRunId: number, plannerRunId: number, attempt: number) => void;
}

export interface ReconcileGraphRunResult {
  graphRunId: number;
  /** The run's status after the pass. */
  status: string;
  /** Node-run status transitions made by this pass. */
  transitions: number;
  /** Node runs handed to the completion pipeline (dead completing/integrating). */
  resumed: number[];
  /** Node runs reverted completing/integrating → running (live process). */
  reverted: number[];
  /** Pending tokens cancelled because the ticket left impl. */
  cancelledTokens: number;
}

type GraphRunRow = Pick<FullGraphRunRow, 'id' | 'ticket_id' | 'status'>;

type NodeRunRow = Pick<FullNodeRunRow, 'id' | 'status' | 'owner_nonce' | 'process_run_id'>;

interface ProcessRunRow {
  pid: number | null;
  started_at: string;
}

function noopResult(graphRunId: number, status: string): ReconcileGraphRunResult {
  return { graphRunId, status, transitions: 0, resumed: [], reverted: [], cancelledTokens: 0 };
}

function ticketAtImpl(db: GraphDb, ticketId: number): boolean {
  const row = db
    .prepare('SELECT stage_current FROM tickets WHERE id = ?')
    .get(ticketId) as { stage_current: string | null } | undefined;
  return row !== undefined && row.stage_current === 'impl';
}

/**
 * True when the run's newest revision is `draining` and it has NO `active`
 * revision. That is the stranded shape an election leaves: the election drained
 * every revision in its transaction, and nothing ever allocated the replan
 * planner — so no `draining → running` (replan acceptance) can ever fire. A
 * `running` run in this shape is the extra corruption Stop/Start produced when
 * `restartStoppedGraph` flipped the run back without checking for an active
 * revision. Step 3 would otherwise no-op it forever: the sweep needs an active
 * revision and `quiescenceBlockedBy` answers `no-revision`.
 */
function runHasStrandedDrainingRevision(db: GraphDb, graphRunId: number): boolean {
  const active = db
    .prepare(
      "SELECT 1 AS x FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active' LIMIT 1",
    )
    .get(graphRunId);
  if (active !== undefined) return false;
  const newest = db
    .prepare(
      'SELECT status FROM approach_graph_revisions WHERE graph_run_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(graphRunId) as { status: string } | undefined;
  return newest?.status === 'draining';
}

/** The draining revision's number whose successor the current replan planner
 *  is compiling (its `target_revision_number`), or undefined when no revision
 *  is draining. */
function drainingRevisionNumber(db: GraphDb, graphRunId: number): number | undefined {
  const row = db
    .prepare(
      `SELECT revision_number FROM approach_graph_revisions
       WHERE graph_run_id = ? AND status = 'draining' ORDER BY id DESC LIMIT 1`,
    )
    .get(graphRunId) as { revision_number: number } | undefined;
  return row?.revision_number;
}

/** The run's node-linked process identity, or null when none exists (a null
 *  pid is equally no evidence — "never declared dead merely because this
 *  window cannot see its terminal"). */
function processOf(
  db: GraphDb,
  node: { process_run_id: number | null },
): { pid: number; startedAt: string | null } | null {
  if (node.process_run_id === null) return null;
  const row = db
    .prepare('SELECT pid, started_at FROM process_runs WHERE id = ?')
    .get(node.process_run_id) as ProcessRunRow | undefined;
  if (!row || row.pid === null) return null;
  return { pid: row.pid, startedAt: row.started_at };
}

/** The two planner kinds the crash matrix judges, each on its own run status. */
type PlannerKind = 'bootstrap' | 'replan';

type PlannerRunRow = Pick<FullPlannerRunRow, 'id' | 'status' | 'owner_nonce' | 'process_run_id'>;

/** The bootstrap planner run's process identity, resolved the SAME way node
 *  runs are (`processOf`): a null `process_run_id`, or a process_runs row
 *  whose pid is null, is no evidence of death — never declared dead merely
 *  because this window cannot see its terminal. */
function plannerProcessOf(db: GraphDb, planner: PlannerRunRow): { pid: number; startedAt: string | null } | null {
  if (planner.process_run_id === null) return null;
  const row = db
    .prepare('SELECT pid, started_at FROM process_runs WHERE id = ?')
    .get(planner.process_run_id) as ProcessRunRow | undefined;
  if (!row || row.pid === null) return null;
  return { pid: row.pid, startedAt: row.started_at };
}

/** The four-way attribution over the injected probes, awaited exactly like the
 *  supervised transport awaits them: both sync and async fact sources feed the
 *  same pure decision (`runtime/serverIdentity.ts` is the mandated evidence
 *  source). The recorded row carries no cwd, so the start-time rule decides. */
async function attributeOf(
  facts: ProcessFactsSource,
  proc: { pid: number; startedAt: string | null },
): Promise<Attribution> {
  const [alive, liveCwd, processStartMs] = await Promise.all([
    facts.isAlive(proc.pid),
    facts.liveCwd(proc.pid),
    facts.processStartMs(proc.pid),
  ]);
  return attributeServer(
    { pid: proc.pid, cwd: null, startedAt: proc.startedAt },
    { isAlive: () => alive, liveCwd: () => liveCwd, processStartMs: () => processStartMs },
  );
}

/**
 * The abandoned drain's node runs that must be cleared before a replan planner
 * can pass the quiescence gate: every active node whose process is provably
 * gone (dead/foreign, or no pid at all). A node this window is driving, another
 * window's live/`unknown` process, and the drain's own `replan` requesters
 * (already excluded from `replanQuiescenceBlockedBy`) are left alone.
 * `completing`/`integrating` nodes are handed back for the completion pipeline
 * to resume, never cancelled — their outcome is in hand and cancelling would
 * skip the artifact recording. No revision filter: a stranded run has NO active
 * revision, so every active node belongs to a draining or superseded revision.
 */
async function collectAbandonedDrainNodes(
  deps: ReconcileGraphRunDeps,
  run: { id: number },
): Promise<{ cancellable: AbandonedNodeRun[]; resumable: number[] }> {
  const cancellable: AbandonedNodeRun[] = [];
  const resumable: number[] = [];
  const rows = deps.db
    .prepare(
      `SELECT id, status, process_run_id, outcome, node_kind, revision_id, node_id
       FROM approach_node_runs WHERE graph_run_id = ? ORDER BY id`,
    )
    .all(run.id) as Array<{
    id: number;
    status: string;
    process_run_id: number | null;
    outcome: string | null;
    node_kind: string;
    revision_id: number;
    node_id: string;
  }>;
  for (const node of rows) {
    if (!ACTIVE_NODE_STATUSES.includes(node.status)) continue;
    if (node.outcome === 'replan') continue; // the drain's evidence; excluded from quiescence
    if (deps.sessionFor(node.id)) continue;
    const proc = processOf(deps.db, node);
    if (proc !== null) {
      const attribution = await attributeOf(deps.facts, proc);
      // Cancel only a PROVABLY gone process. `attributable` is another window's
      // live work; `unknown` is a live pid we cannot identify — both are left
      // alone (reconcileRunning parks `unknown` as `termination-unknown` for an
      // explicit discard, never a silent cancel). Only `dead`/`foreign` (or no
      // pid at all) are void.
      if (attribution !== 'dead' && attribution !== 'foreign') continue;
    } else if (node.status === 'completing' || node.status === 'integrating') {
      continue; // no pid evidence — never judged (mirrors reconcileCompleting)
    }
    if (node.status === 'completing' || node.status === 'integrating') {
      resumable.push(node.id);
      continue;
    }
    cancellable.push({
      id: node.id,
      status: node.status,
      nodeKind: node.node_kind,
      revisionId: node.revision_id,
      nodeId: node.node_id,
    });
  }
  return { cancellable, resumable };
}

/**
 * Move a node run to a rest state AND state the cause ON THE NODE. The node's
 * own `reason` is what the Inside graph view renders per node, and it is
 * written by other parkers (`parkLaunchFailure`, the replan budget), so a
 * status change here that left it alone made the row keep a reason belonging
 * to an earlier park — naming a cause that is no longer true. Returns false
 * when the CAS lost (another window moved the row); the reason is written
 * only on the transition that actually happened.
 */
function parkNode(
  deps: ReconcileGraphRunDeps,
  nodeRunId: number,
  from: string,
  to: string,
  reason: string,
): boolean {
  if (!casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, nodeRunId, from, to)) {
    return false;
  }
  setNodeRunReason(deps.db, nodeRunId, reason);
  return true;
}

/** Block the run with a reason, CAS-guarded: a run another window already
 *  blocked is a no-op, never a re-write of its reason. */
function blockRun(deps: ReconcileGraphRunDeps, graphRunId: number, reason: string): void {
  if (
    casStatus(
      deps.db,
      'approach_graph_runs',
      GRAPH_RUN_TRANSITIONS,
      graphRunId,
      'running',
      'blocked',
    )
  ) {
    markGraphRunBlocked(deps.db, graphRunId, reason, deps.now());
    deps.debug?.(`[graph] reconcile: run ${graphRunId} blocked (${reason})`);
  }
}

/**
 * Step 1: the ticket left `impl`. Cancel unscheduled (pending) tokens and
 * cancel the run so no new graph work can start — the sweep refuses
 * non-`running` runs, the pipeline refuses a non-`running` graph, and the CLI
 * already rejects wrong-attempt completions. Completed evidence is never
 * rewritten: node runs are untouched and a marker-ready run is not cancelled.
 */
function cancelForLeftTicket(
  deps: ReconcileGraphRunDeps,
  run: GraphRunRow,
): { cancelledTokens: number } {
  return deps.transaction(() => {
    const pending = deps.db
      .prepare(
        `SELECT t.id FROM approach_graph_tokens t
         JOIN approach_graph_revisions r ON r.id = t.revision_id
         WHERE r.graph_run_id = ? AND t.status = 'pending'`,
      )
      .all(run.id) as { id: number }[];
    let cancelledTokens = 0;
    for (const token of pending) {
      if (cancelGraphToken(deps.db, token.id)) cancelledTokens += 1;
    }
    if (CANCELLABLE_RUN_STATUSES.includes(run.status as (typeof CANCELLABLE_RUN_STATUSES)[number])) {
      casStatus(deps.db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, run.id, run.status, 'cancelled');
      touchGraphRun(deps.db, run.id, deps.now());
    }
    deps.debug?.(
      `[graph] reconcile: run ${run.id} — ticket no longer at impl; cancelled ${cancelledTokens} pending token(s)`,
    );
    return { cancelledTokens };
  });
}

/** Whether any node of the run still has a live process: a session in this
 *  window's registry, or a recorded pid the OS says is alive. Conservative —
 *  an alive-but-unattributable pid also counts as live, because the successor
 *  rule must never accuse a process that may be another window's. */
async function runHasLiveProcess(deps: ReconcileGraphRunDeps, graphRunId: number): Promise<boolean> {
  const nodes = nodeRunIdsForGraphRun(deps.db, graphRunId);
  for (const node of nodes) {
    if (deps.sessionFor(node)) return true;
  }
  // The durable half is shared with Stop (`coordinator/liveness.ts`) — both
  // callers must answer "is anything still alive" the same way.
  return await graphRunHasLiveNodeProcess(deps.db, deps.facts, graphRunId, deps.debug);
}

/**
 * The `launching` rows: a persisted owner nonce (written BEFORE spawn) with no
 * process identity proves the spawn was never reached — provably retryable,
 * so the node parks at the rest state current recovery already handles
 * (`blocked`, with a `node-blocked` reason). A row with no owner nonce and no
 * process identity is the recovery-rearmed retry shape: `retryReservedVisits`
 * CASes the node `→ launching` AND clears the dead attempt's identity
 * (`clearLaunchIdentity`) in the SAME transaction, and it is the ONLY producer
 * of that shape — the driver commits a fresh owner nonce inside the
 * transaction that re-launches the row, so a launch in flight in another
 * window is never observable without launch identity. The armed row is waiting
 * for the driver's periodic relaunch (`driveReadyNodeRuns` selects exactly
 * `launching` + no owner nonce + no process as launchable), so reconcile NEVER
 * parks it: parking would re-block the run the recovery just un-blocked, and
 * in a multi-window setup another window's reconcile landing between the
 * retry and the relaunch is what turns a Resume into a loop the user must
 * click out of. An identity whose process cannot be attributed is ambiguous:
 * `launch-unknown`, which blocks and is never auto-retried (the discard action
 * is the named exit).
 */
async function reconcileLaunching(
  deps: ReconcileGraphRunDeps,
  graphRunId: number,
  node: NodeRunRow,
): Promise<number> {
  if (deps.sessionFor(node.id)) return 0; // this window is mid-launch
  const proc = processOf(deps.db, node);
  if (proc === null) {
    if (node.owner_nonce !== null) {
      return deps.transaction(() => {
        const reason = `node-blocked: node ${node.id} crashed before spawn (owner nonce, no process) — Resume to relaunch the reserved visit`;
        if (!parkNode(deps, node.id, 'launching', 'blocked', reason)) return 0;
        blockRun(deps, graphRunId, reason);
        return 1;
      });
    }
    // No owner nonce and no process row: the recovery-rearmed retry shape,
    // armed by `retryReservedVisits`/`clearLaunchIdentity` and waiting for the
    // driver's periodic relaunch (`driveReadyNodeRuns` selects it as
    // launchable). It is NOT a crash to recover — parking it re-blocks the run
    // the recovery just un-blocked, and a concurrent window's reconcile landing
    // between the retry and the relaunch is exactly the "Resume did nothing"
    // loop. Left alone, the next sweep's continuation relaunches it.
    return 0;
  }
  const attribution = await attributeOf(deps.facts, proc);
  if (attribution === 'attributable') return 0; // another window owns the launch
  if (attribution === 'dead' || attribution === 'foreign') {
    return deps.transaction(() => {
      const reason = `node-blocked: node ${node.id} launch process (pid ${proc.pid}) is gone — Resume to relaunch the reserved visit`;
      if (!parkNode(deps, node.id, 'launching', 'blocked', reason)) return 0;
      blockRun(deps, graphRunId, reason);
      return 1;
    });
  }
  return deps.transaction(() => {
    const reason = `launch-unknown: node ${node.id} launch identity is unprovable — discard the unknown process to recover`;
    if (!parkNode(deps, node.id, 'launching', 'launch-unknown', reason)) return 0;
    blockRun(deps, graphRunId, reason);
    return 1;
  });
}

/** The `running` rows: dead/foreign → `stale` + recoverable block; unprovable
 *  → `termination-unknown` (held leases flip `ambiguous-process` — the flip
 *  happens exactly here, never a release); live attributable → left alone
 *  (another window owns it). No pid → never judged. */
async function reconcileRunning(
  deps: ReconcileGraphRunDeps,
  graphRunId: number,
  node: NodeRunRow,
): Promise<number> {
  if (deps.sessionFor(node.id)) return 0; // this window owns it
  const proc = processOf(deps.db, node);
  if (proc === null) return 0; // no pid evidence — never declared dead
  const attribution = await attributeOf(deps.facts, proc);
  if (attribution === 'attributable') return 0;
  if (attribution === 'dead' || attribution === 'foreign') {
    return deps.transaction(() => {
      const reason = `node-blocked: node ${node.id} process (pid ${proc.pid}) is gone (${attribution} at reconcile) — Resume to relaunch the reserved visit`;
      if (!parkNode(deps, node.id, 'running', 'stale', reason)) return 0;
      blockRun(deps, graphRunId, reason);
      return 1;
    });
  }
  return deps.transaction(() => {
    const reason = `termination-unknown: node ${node.id} process (pid ${proc.pid}) death is unprovable — discard the unknown process to recover`;
    if (!parkNode(deps, node.id, 'running', 'termination-unknown', reason)) {
      return 0;
    }
    // Slice 5 Task 2: a lease of a node whose process death is unprovable is
    // ambiguous-process from here on — a conflicting launch is blocked and no
    // automatic release may ever move it (only the discard action can).
    markLeaseAmbiguous(deps.db, node.id);
    deps.debug?.(
      `[graph] reconcile: node ${node.id} process death unprovable — termination-unknown, leases marked ambiguous-process`,
    );
    return 1;
  });
}

/**
 * The `completing`/`integrating` rows: a dead process resumes the completion
 * pipeline where it stopped (the reported outcome is in hand — re-running
 * would duplicate spend and integration), a live attributable process reverts
 * to `running` so completion proceeds normally, and an unprovable one is left
 * alone (the completion drive parks it conservatively). A session in this
 * window means the completion path is already being driven here.
 */
async function reconcileCompleting(
  deps: ReconcileGraphRunDeps,
  graphRunId: number,
  node: NodeRunRow,
  status: 'completing' | 'integrating',
  result: ReconcileGraphRunResult,
): Promise<number> {
  if (deps.sessionFor(node.id)) return 0;
  const proc = processOf(deps.db, node);
  if (proc === null) return 0; // no pid evidence — never judged dead
  const attribution = await attributeOf(deps.facts, proc);
  if (attribution === 'dead' || attribution === 'foreign') {
    deps.debug?.(
      `[graph] reconcile: node ${node.id} (${status}) process gone — resuming the completion pipeline`,
    );
    deps.resumePipeline(node.id);
    result.resumed.push(node.id);
    return 0;
  }
  if (attribution === 'attributable') {
    const moved = deps.transaction(() =>
      casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, node.id, status, 'running'),
    );
    if (moved) {
      result.reverted.push(node.id);
      deps.debug?.(
        `[graph] reconcile: node ${node.id} (${status}) has a live attributable process — reverted to running`,
      );
      return 1;
    }
    return 0;
  }
  return 0;
}

/**
 * The planner branch of the crash matrix (between the successor rule and the
 * run-level gates), shared by both planner kinds because the decision is the
 * same one: the run's NEWEST planner run of that kind whose session is
 * demonstrably gone — a `running` planner whose process is dead/foreign, or a
 * `launching` planner whose owner nonce (committed with the claim, BEFORE
 * spawn) has no process identity, or whose process is dead/foreign — is
 * marked `stale` and relaunched on the SAME graph run.
 *
 * Each kind is judged only in the run status it works in, and the run stays
 * in that status: a `bootstrap` planner at `planning`, so the relaunched
 * planner's submission is accepted by `acceptSubmittedPlan`; a `replan`
 * planner at `draining`, so its submission is accepted by the replan
 * machinery. Judging the other kind's planner would be a category error —
 * a draining run's bootstrap planner has already done its work and exited,
 * and relaunching it would recompile a revision that was superseded.
 *
 * Reconcile only decides; the fire-and-forget relaunch callback launches, and
 * only after the `stale` transition commits — the launch opens its own
 * `BEGIN IMMEDIATE`, and a nested `BEGIN` on the same connection throws.
 * Everything else — a session in this window, a live attributable process
 * (another window owns it), no pid evidence, an unprovable death, or a
 * non-live planner status — is a no-op.
 */
async function reconcilePlannerRun(
  deps: ReconcileGraphRunDeps,
  run: GraphRunRow,
  kind: PlannerKind,
): Promise<ReconcileGraphRunResult> {
  const relaunch = kind === 'bootstrap' ? deps.relaunchPlanner : deps.relaunchReplanPlanner;

  // ONLY a genuinely mid-replan drain may have its leftover replan planners
  // judged. A STOP drain keeps its revision `active` (Stop never touches it),
  // so any replan planner row it still carries belongs to an EARLIER drain —
  // acting on it (compile repair, stale+relaunch) would launch a planner on a
  // run the user deliberately stopped.
  if (kind === 'replan' && !runHasStrandedDrainingRevision(deps.db, run.id)) {
    return planningResult(deps, run, 0);
  }

  // A bootstrap planner is unique to its `planning` run. A REPLAN planner is
  // scoped to the drain it serves by `target_revision_number`, so a run that
  // replanned before is never judged against a prior drain's planner — the
  // prior drain's `submitted` planner would otherwise read as a live planner
  // and strand the new drain forever.
  const drainTarget = kind === 'replan' ? drainingRevisionNumber(deps.db, run.id) : undefined;
  const planner =
    kind === 'bootstrap'
      ? latestPlannerRunForGraphRunKind(deps.db, run.id, 'bootstrap')
      : drainTarget === undefined
        ? latestPlannerRunForGraphRunKind(deps.db, run.id, 'replan')
        : latestReplanPlannerForTarget(deps.db, run.id, drainTarget + 1);

  // The election→launch gap: a genuinely mid-replan drain (the run and its
  // revision drained, counter incremented) with NO planner for THIS drain — or
  // only an abandoned one — means the planner was never allocated (the host
  // died between the election and the launch, or the recovery returned while
  // the drain was not yet quiescent and nothing ever re-drove it), or its
  // launch died. Launch one now; the host's `beginReplanPlannerRun` re-checks
  // `draining` + quiescence + single-flight itself, so this is a safe,
  // retryable dispatch.
  //
  // The revision discriminant matters: a STOP drain keeps its revision
  // `active` (Stop never touches it) and must WAIT for a deliberate Restart —
  // auto-launching a planner for it would defeat the H2 Stop/Restart design.
  // Only `draining`-with-no-active is mid-replan. A `planning` run always has
  // its bootstrap planner (created with the run in one transaction), so the
  // no-row case is replan-only.
  if (
    kind === 'replan' &&
    runHasStrandedDrainingRevision(deps.db, run.id) &&
    (planner === undefined || planner.status === 'stale' || planner.status === 'cancelled')
  ) {
    deps.debug?.(
      `[graph] reconcile: run ${run.id} draining with no planner for its target revision — launching one`,
    );
    relaunch(run.id);
    // No durable transition happened HERE — the allocation (and its single-
    // flight refusal) is the host's, so the count stays honest.
    return planningResult(deps, run, 0);
  }
  if (!planner) return planningResult(deps, run, 0);
  if (deps.sessionFor(planner.id)) return planningResult(deps, run, 0); // this window owns it
  const proc = plannerProcessOf(deps.db, planner);

  // G2's fire-once re-prompt, made recoverable from the sweep: a bootstrap
  // planner sitting `blocked` (its submitted document was rejected and an
  // attempt remains — `rejectPlan` only ever produces this shape when
  // `compile_attempt < MAX_COMPILE_ATTEMPTS`) with no live session and no live
  // process is a re-prompt that never happened, or died in flight. Judged with
  // the SAME evidence discipline as every other row here: a live attributable
  // process (another window already relaunching it) is left strictly alone.
  // H1: both kinds reach this branch now — `acceptSubmittedReplan` routes a
  // rejected replan through the SAME bounded repair, so a replan planner sits
  // `blocked` at `draining` exactly as a bootstrap planner does at `planning`,
  // and the run status each is judged in is the one its re-prompt submits
  // back into.
  if (planner.status === 'blocked') {
    if (proc !== null) {
      const attribution = await attributeOf(deps.facts, proc);
      if (attribution === 'attributable') return planningResult(deps, run, 0);
    }
    const attempt = plannerRunCompileAttempt(deps.db, planner.id);
    if (attempt >= MAX_COMPILE_ATTEMPTS) return planningResult(deps, run, 0); // exhausted — never re-prompted
    deps.debug?.(
      `[graph] reconcile: run ${run.id} bootstrap planner ${planner.id} blocked awaiting compile repair — re-prompting (attempt ${attempt})`,
    );
    deps.relaunchCompileRepair(run.id, planner.id, attempt);
    return planningResult(deps, run, 0);
  }

  /** Mark the planner run `stale` + relaunch. The CAS-guarded `stale`
   *  transition is the single-flight gate — only the window that moved the
   *  run (raced windows read `false`) fires the launch, so a second window
   *  never relaunches a planner another already revived. The fire-and-forget
   *  `relaunchPlanner` callback runs AFTER the transaction commits: the
   *  launch opens its own `BEGIN IMMEDIATE` transaction, and a nested `BEGIN`
   *  on the same connection throws. */
  const staleAndRelaunch = (message: string): ReconcileGraphRunResult => {
    const won = deps.transaction(() => {
      if (!transitionPlannerRun(deps.db, planner.id, planner.status, 'stale')) {
        return false;
      }
      deps.debug?.(message);
      return true;
    });
    if (!won) return planningResult(deps, run, 0);
    relaunch(run.id);
    return planningResult(deps, run, 1);
  };

  if (planner.status === 'ready') {
    // A bootstrap planner left `ready` is NOT this sweep's to retry — the base
    // behaviour was a no-op, and re-driving it would stream a fresh planner row
    // every pass when the profile/worktree is persistently unresolvable.
    if (kind === 'bootstrap') return planningResult(deps, run, 0);
    // A replan planner left `ready` was allocated but never launched: the
    // window died between allocation and `launchReplanPlanner`, or the host
    // returned before launching (e.g. the launch worktree could not be
    // resolved). Mark it stale (the CAS makes this window the single-flight
    // winner) and relaunch — BOUNDED, so a persistently failing launch cannot
    // allocate a fresh row every sweep.
    const attempts =
      drainTarget === undefined
        ? 0
        : countReplanPlannersForTarget(deps.db, run.id, drainTarget + 1);
    if (attempts > MAX_REPLAN_LAUNCH_ATTEMPTS) {
      // Exhausted. Park the run `blocked` — the one status Resume reaches —
      // instead of leaving a live-looking `ready` row that blocks both the
      // single-flight gate and the H2 Restart. `planner-artifact-missing` maps
      // to the replan recovery tier, so Resume has a real exit.
      const parked = deps.transaction(() => {
        if (!transitionPlannerRun(deps.db, planner.id, 'ready', 'stale')) return false;
        if (
          !casStatus(
            deps.db,
            'approach_graph_runs',
            GRAPH_RUN_TRANSITIONS,
            run.id,
            'draining',
            'blocked',
          )
        ) {
          return false;
        }
        markGraphRunBlocked(
          deps.db,
          run.id,
          `planner-artifact-missing: replan planner ${planner.id} never launched after ${attempts} attempts`,
          deps.now(),
        );
        return true;
      });
      if (!parked) return planningResult(deps, run, 0);
      deps.debug?.(
        `[graph] reconcile: run ${run.id} replan planner ${planner.id} could not launch after ${attempts} attempts — blocking for recovery`,
      );
      return planningResult(deps, run, 1);
    }
    return staleAndRelaunch(
      `[graph] reconcile: run ${run.id} ${kind} planner ${planner.id} is ready but was never launched — relaunching the planner`,
    );
  }

  if (planner.status === 'running') {
    if (proc === null) return planningResult(deps, run, 0); // no pid evidence — never declared dead
    const attribution = await attributeOf(deps.facts, proc);
    if (attribution === 'dead' || attribution === 'foreign') {
      return staleAndRelaunch(
        `[graph] reconcile: run ${run.id} ${kind} planner ${planner.id} process (pid ${proc.pid}) is gone (${attribution}) — relaunching the planner`,
      );
    }
    return planningResult(deps, run, 0); // attributable (another window) or unprovable
  }

  if (planner.status === 'launching') {
    if (proc === null) {
      // A persisted owner nonce with no process identity proves the spawn was
      // never reached — provably crashed before spawn.
      if (planner.owner_nonce !== null) {
        return staleAndRelaunch(
          `[graph] reconcile: run ${run.id} ${kind} planner ${planner.id} crashed before spawn (owner nonce, no process) — relaunching the planner`,
        );
      }
      return planningResult(deps, run, 0); // unprovable — leave alone
    }
    const attribution = await attributeOf(deps.facts, proc);
    if (attribution === 'dead' || attribution === 'foreign') {
      return staleAndRelaunch(
        `[graph] reconcile: run ${run.id} ${kind} planner ${planner.id} process (pid ${proc.pid}) is gone (${attribution}) — relaunching the planner`,
      );
    }
    return planningResult(deps, run, 0);
  }

  // Other planner statuses (submitted, blocked, stale, cancelled, ready) are
  // not a live-session-loss to relaunch.
  return planningResult(deps, run, 0);
}

/** A planning-branch result with the run's status re-read after the pass. */
function planningResult(
  deps: ReconcileGraphRunDeps,
  run: GraphRunRow,
  transitions: number,
): ReconcileGraphRunResult {
  const after = graphRunStatus(deps.db, run.id) ?? run.status;
  return { graphRunId: run.id, status: after, transitions, resumed: [], reverted: [], cancelledTokens: 0 };
}

/**
 * One pass over one graph run, applying the crash matrix in order. Returns a
 * bounded result; every mutation is a CAS-guarded durable claim, so concurrent
 * windows reconcile safely and a raced transition is a no-op, never a throw.
 */
export async function reconcileGraphRun(
  deps: ReconcileGraphRunDeps,
  input: { graphRunId: number },
): Promise<ReconcileGraphRunResult> {
  const db = deps.db;
  const run = graphRunIdTicketStatus(db, input.graphRunId);
  if (!run) return noopResult(input.graphRunId, 'gone');
  if (run.status === 'closed' || run.status === 'stale' || run.status === 'cancelled') {
    return noopResult(input.graphRunId, run.status);
  }

  // 1. Ticket gate: no longer at impl → cancel unscheduled tokens + run.
  if (!ticketAtImpl(db, run.ticket_id)) {
    const { cancelledTokens } = cancelForLeftTicket(deps, run);
    const after = graphRunStatus(db, run.id) ?? run.status;
    return {
      graphRunId: run.id,
      status: after,
      transitions: 0,
      resumed: [],
      reverted: [],
      cancelledTokens,
    };
  }

  // 2. Successor-run staleness: a later run for the same ticket means the
  //    earlier host died — unless a process is still alive (another window).
  if (SUPERSEDABLE_RUN_STATUSES.includes(run.status as (typeof SUPERSEDABLE_RUN_STATUSES)[number])) {
    const successor = nextGraphRunIdForTicketAfter(db, run.ticket_id, run.id);
    if (successor && !(await runHasLiveProcess(deps, run.id))) {
      const moved = deps.transaction(() => {
        if (!casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, run.id, run.status, 'stale')) {
          return false;
        }
        touchGraphRun(db, run.id, deps.now());
        return true;
      });
      if (moved) {
        deps.debug?.(`[graph] reconcile: run ${run.id} superseded by run ${successor} — marked stale`);
        return noopResult(run.id, 'stale');
      }
      // Raced: another window moved it; re-read for the gates below.
      run.status = graphRunStatus(db, run.id) ?? run.status;
    }
  }

  // 2.5. Planning-run bootstrap planner crash matrix: a planning run whose
  //      newest bootstrap planner session is demonstrably gone is marked
  //      `stale` and the planner relaunched on the SAME run — the run stays
  //      `planning`, so the relaunched planner's later submission is accepted
  //      by `acceptSubmittedPlan`.
  if (run.status === 'planning') {
    return await reconcilePlannerRun(deps, run, 'bootstrap');
  }

  // 2.55. Self-heal a STRANDED running run: its newest revision is `draining`
  //       and it has no `active` revision. That is the shape a Stop/Start over
  //       an in-flight replan produced — the election had drained the revision,
  //       and a restart (before its guard) flipped the run back to `running`.
  //       Step 3 would no-op it forever (the sweep needs an active revision;
  //       `quiescenceBlockedBy` answers `no-revision`), so CAS it back to
  //       `draining` — and CANCEL the abandoned revision's still-active node
  //       runs, which the Stop left non-terminal. The replan planner's
  //       quiescence gate counts those node runs, so without cancelling them no
  //       planner is ever allocated and the repair re-strands.
  let selfHealed = 0;
  if (run.status === 'running' && runHasStrandedDrainingRevision(db, run.id)) {
    const { cancellable, resumable } = await collectAbandonedDrainNodes(deps, run);
    // Hand the resumable completions back to the host BEFORE the run moves: the
    // running-gated node sweep can never reach them once the run is `draining`.
    for (const id of resumable) deps.resumePipeline(id);
    selfHealed = deps.transaction(() => {
      if (!casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, run.id, 'running', 'draining')) {
        return 0;
      }
      return 1 + cancelNodeRuns(deps, run.id, cancellable);
    });
    if (selfHealed > 0) {
      deps.debug?.(
        `[graph] reconcile: run ${run.id} running with a draining revision and no active revision — re-draining for replan recovery (cancelled ${selfHealed - 1} abandoned node run(s))`,
      );
    }
    run.status = graphRunStatus(db, run.id) ?? run.status;
  }

  // 2.6. Draining-run replan planner crash matrix. `draining` is entered to
  //      let a replan planner compile the next revision, and it is the one
  //      run status with no exit of its own — only that planner's accepted
  //      submission leaves it. So a replan planner whose session is gone
  //      strands the ticket exactly as a lost bootstrap planner strands a
  //      planning run, and it is judged on the same evidence. The run STAYS
  //      draining: `draining` has no `blocked` edge, and the fresh planner's
  //      submission is only accepted while it drains.
  if (run.status === 'draining') {
    // A stranded drain (no active revision) whose non-terminal node's process
    // died can never pass the replan quiescence gate, and the running-gated node
    // sweep can never reach it — clear the abandoned nodes first. A Stop drain
    // keeps its revision `active` and is left for a deliberate Restart. Skip
    // when the self-heal already collected this tick (it just moved the run here).
    let nodeTransitions = 0;
    if (selfHealed === 0 && runHasStrandedDrainingRevision(db, run.id)) {
      const { cancellable, resumable } = await collectAbandonedDrainNodes(deps, run);
      for (const id of resumable) deps.resumePipeline(id);
      if (cancellable.length > 0) {
        nodeTransitions = deps.transaction(() => cancelNodeRuns(deps, run.id, cancellable));
      }
    }
    const replanResult = await reconcilePlannerRun(deps, run, 'replan');
    const extra = selfHealed + nodeTransitions;
    return extra === 0 ? replanResult : { ...replanResult, transitions: replanResult.transitions + extra };
  }

  // 3. Run-level gates: blocked stays, marker-ready stays, draining waits.
  if (run.status !== 'running') return noopResult(run.id, run.status);
  const revision = db
    .prepare(
      "SELECT status FROM approach_graph_revisions WHERE graph_run_id = ? AND status IN ('active','draining') ORDER BY id DESC LIMIT 1",
    )
    .get(run.id) as { status: string } | undefined;
  if (revision?.status === 'draining') return noopResult(run.id, run.status);

  // 4. Node-level sweep, deterministic node-run order.
  const nodes = nodeRunsForGraphRun(db, run.id);
  const result: ReconcileGraphRunResult = {
    graphRunId: run.id,
    status: run.status,
    transitions: 0,
    resumed: [],
    reverted: [],
    cancelledTokens: 0,
  };
  for (const node of nodes) {
    switch (node.status) {
      case 'launching':
        result.transitions += await reconcileLaunching(deps, run.id, node);
        break;
      case 'running':
        result.transitions += await reconcileRunning(deps, run.id, node);
        break;
      case 'completing':
        result.transitions += await reconcileCompleting(deps, run.id, node, 'completing', result);
        break;
      case 'integrating':
        result.transitions += await reconcileCompleting(deps, run.id, node, 'integrating', result);
        break;
      default:
        break; // rest states and completed/cancelled evidence are left alone
    }
  }
  result.status = graphRunStatus(db, run.id) ?? run.status;
  return result;
}
