/**
 * Discard unknown process (Slice 4 Task 4).
 *
 * The named exit for the permanent-stall class: `launch-unknown` and
 * `termination-unknown` node runs have no provable process fate, so nothing
 * may auto-retry them and no lease may auto-release. `discardUnknownProcess`
 * is the ONE explicit user action that resolves them, in ONE `BEGIN IMMEDIATE`
 * transaction:
 *
 *  1. verify the node run is in one of the two ambiguous statuses;
 *  2. cancel its claimed tokens (`claimed → cancelled`);
 *  3. mark the node run `cancelled` (the CAS is the transaction's gate — a
 *     second window that already discarded the run reads a moved row and the
 *     whole transaction is the idempotent no-op `{discarded:false,
 *     reason:'not-ambiguous'}`);
 *  4. release the reserved budget contributions — graph `node_run_count`
 *     always, and `expert_run_count` when the claim reserved the expert budget
 *     (an agent node whose PINNED declared profile is `expert`, the exact rule
 *     `sweep.ts` used at reserve time). The run's `visit_number` is evidence
 *     and is never touched: a cancelled visit stays recorded;
 *  5. release the run's leases — the ONLY path that releases a lease without
 *     proven termination (`releaseLeaseForNodeRun(…, {allowAmbiguous})` moves
 *     both `held` and `ambiguous-process` → `released`);
 *  6. re-evaluate the graph: if the discarded run was the last satisfier, the
 *     run blocks with `graph-topology-deadlock` — a recoverable blocker the
 *     recovery action refuses to auto-retry, leading to replan or an explicit
 *     resolution, so a discarded revision never leaves a silently dead graph.
 *  7. after that transaction commits, clean the now-terminal node workspace;
 *     cleanup is best-effort and never changes the discard verdict.
 *
 * V1 deadlock scope (documented, deliberately simple): the check fires only
 * when the discard leaves the active revision with NO END token, NO
 * pending/claimed non-END token, and NO non-terminal node run — i.e. the
 * discarded run was the graph's only remaining satisfier and nothing will
 * ever produce an END token. It does NOT analyse join-arrival completeness: a
 * partial-arrival join whose one branch was discarded leaves pending tokens
 * and is therefore not flagged (that graph still has work the coordinator
 * schedules; the next discard or a replan resolves it). A healthy graph that
 * still has pending work or an in-flight run is left running.
 *
 * A late completion arriving after the discard is rejected idempotently: the
 * claimed token is already `cancelled`, so the completion CAS moves nothing
 * and no successor edge is emitted.
 *
 * Host-agnostic: db, transaction and clock injected; no vscode, no machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { casStatus, GRAPH_RUN_TRANSITIONS, NODE_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import { cancelGraphToken } from '../../../store/graph/tokens.js';
import { releaseLeaseForNodeRun } from './leases.js';
import { releaseProcessSlot } from '../../../store/graph/nodeRuns.js';
import { parseGraphDocument } from '../parse.js';

/** The graph blocker reason a discard writes when the edge can no longer fire. */
export const GRAPH_TOPOLOGY_DEADLOCK = 'graph-topology-deadlock' as const;

/** The ambiguous node-run statuses the discard operates on. */
export const AMBIGUOUS_NODE_STATUSES = ['launch-unknown', 'termination-unknown'] as const;

/** The non-terminal node-run statuses that count as live work in the V1
 *  deadlock re-evaluation. Mirrors the quiescence rule: any of these means the
 *  graph can still make progress and must not be read as silently dead. */
const ACTIVE_NODE_STATUSES = [
  'ready',
  'waiting-resource',
  'launching',
  'running',
  'completing',
  'integrating',
  'launch-unknown',
  'termination-unknown',
  'failed-to-launch',
  'blocked',
  'output-artifact-missing',
  'artifact-unsafe',
  'stale',
] as const;

export interface DiscardDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
  /** Best-effort cleanup after the node is durably cancelled. */
  cleanupNodeWorkspace: (input: { graphRunId: number; nodeRunId: number }) => void;
}

export interface DiscardInput {
  nodeRunId: number;
  /** Defense-in-depth: when supplied, must match the node run's own graph run.
   *  The authoritative graph run id is always derived from the row itself. */
  graphRunId?: number;
}

export type DiscardResult =
  | { discarded: false; reason: 'not-found' | 'not-ambiguous' }
  | {
      discarded: true;
      cancelledTokens: number;
      releasedLeases: number;
      graphBlockedWith: 'graph-topology-deadlock' | null;
    };

interface NodeRunRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  node_kind: string;
  status: string;
}

/** Whether the claim reserved the expert budget: exactly the sweep's
 *  `profileIsExpert` rule — an agent node whose PINNED declared profile is
 *  `expert` (the same source of truth `claim.ts`'s `reserveBudgets` read).
 *  An unparseable revision or absent node is conservatively NOT expert. */
function runReservedExpert(db: GraphDb, node: NodeRunRow): boolean {
  if (node.node_kind !== 'agent') return false;
  const revision = db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(node.revision_id) as { canonical_graph: string } | undefined;
  if (!revision) return false;
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return false;
  const pinned = parsed.document.nodes.find((n) => n.id === node.node_id);
  return pinned?.kind === 'agent' && pinned.profile === 'expert';
}

/** The V1 topology-deadlock rule: the active revision has no END token, no
 *  pending/claimed non-END token, and the graph has no non-terminal node run —
 *  the graph is silent with nothing left that could produce an END token. See
 *  the module doc for the deliberate V1 scope. */
function revisionIsTopologyDeadlocked(db: GraphDb, graphRunId: number): boolean {
  const revision = db
    .prepare("SELECT id FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'")
    .get(graphRunId) as { id: number } | undefined;
  if (!revision) return false;
  const endTokens = db
    .prepare(
      'SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE revision_id = ? AND destination_end = 1',
    )
    .get(revision.id) as { n: number };
  if (endTokens.n > 0) return false;
  const work = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_graph_tokens
       WHERE revision_id = ? AND destination_end = 0 AND status IN ('pending','claimed')`,
    )
    .get(revision.id) as { n: number };
  if (work.n > 0) return false;
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${ACTIVE_NODE_STATUSES.map(() => '?').join(',')})`,
    )
    .all(graphRunId, ...ACTIVE_NODE_STATUSES) as { n: number }[];
  return (active[0]?.n ?? 0) === 0;
}

/**
 * Discard one ambiguous node run and re-evaluate the graph, in one
 * transaction. Returns the closed result; a raced second window's CAS moves
 * nothing and the call is the idempotent no-op, never a partial mutation.
 */
export function discardUnknownProcess(deps: DiscardDeps, input: DiscardInput): DiscardResult {
  let cleanupInput: { graphRunId: number; nodeRunId: number } | undefined;
  const result = deps.transaction((): DiscardResult => {
    const db = deps.db;

    // 1. Verify the node is in one of the two ambiguous statuses.
    const node = db
      .prepare(
        'SELECT id, graph_run_id, revision_id, node_id, node_kind, status FROM approach_node_runs WHERE id = ?',
      )
      .get(input.nodeRunId) as NodeRunRow | undefined;
    if (!node) return { discarded: false, reason: 'not-found' };
    if (input.graphRunId !== undefined && input.graphRunId !== node.graph_run_id) {
      return { discarded: false, reason: 'not-found' };
    }
    if (node.status !== 'launch-unknown' && node.status !== 'termination-unknown') {
      return { discarded: false, reason: 'not-ambiguous' };
    }
    const graphRunId = node.graph_run_id;

    // 2. Conditionally move its claimed tokens claimed → cancelled. Under the
    //    BEGIN IMMEDIATE lock the read above IS the gate; the node CAS below
    //    is the atomic backstop a raced window reads as a no-op.
    const claimed = db
      .prepare(
        "SELECT id FROM approach_graph_tokens WHERE claiming_node_run_id = ? AND status = 'claimed'",
      )
      .all(node.id) as { id: number }[];
    let cancelledTokens = 0;
    for (const token of claimed) {
      if (cancelGraphToken(db, token.id)) cancelledTokens += 1;
    }

    // 3. Mark the node run cancelled. A second window that already discarded
    //    this run reads a moved row → the whole transaction is the idempotent
    //    no-op (nothing above committed, nothing here mutates).
    if (!casStatus(db, 'approach_node_runs', NODE_RUN_TRANSITIONS, node.id, node.status, 'cancelled')) {
      return { discarded: false, reason: 'not-ambiguous' };
    }
    db.prepare('UPDATE approach_node_runs SET ended_at = ? WHERE id = ?').run(deps.now(), node.id);

    // 4. Release the reserved budget contributions: graph node_run_count
    //    always, expert_run_count when the claim reserved expert. Both guards
    //    are `> 0` — a count must never go negative. The run's visit_number is
    //    recorded evidence and is deliberately untouched.
    const expert = runReservedExpert(db, node);
    db.prepare(
      'UPDATE approach_graph_runs SET node_run_count = node_run_count - 1, updated_at = ? WHERE id = ? AND node_run_count > 0',
    ).run(deps.now(), graphRunId);
    if (expert) {
      db.prepare(
        'UPDATE approach_graph_runs SET expert_run_count = expert_run_count - 1, updated_at = ? WHERE id = ? AND expert_run_count > 0',
      ).run(deps.now(), graphRunId);
    }

    // 5. Release the run's leases — the ONLY path that releases a lease
    //    without proven termination. Discard passes `allowAmbiguous`, so BOTH
    //    `held` and `ambiguous-process` → `released`; no other caller may
    //    move an ambiguous-process lease (pinned in coordinator/leases.test).
    const releasedLeases = releaseLeaseForNodeRun(db, node.id, { allowAmbiguous: true });
    // Slice 5 Task 3: the discarded run's process is gone (or will never be
    // trusted again) — its slot under the external-process ceiling is released
    // with its lease, so a discarded ambiguous run cannot pin the ceiling.
    releaseProcessSlot(db, graphRunId);

    // 6. Re-evaluate: block with graph-topology-deadlock when the discarded
    //    run was the only remaining satisfier; otherwise leave the graph
    //    running. The CAS only moves a `running` run — an already-blocked run
    //    keeps its existing (stale) block, which recovery/Resume resolves.
    let graphBlockedWith: 'graph-topology-deadlock' | null = null;
    if (revisionIsTopologyDeadlocked(db, graphRunId)) {
      if (casStatus(db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, 'running', 'blocked')) {
        db.prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?').run(
          GRAPH_TOPOLOGY_DEADLOCK,
          deps.now(),
          graphRunId,
        );
        graphBlockedWith = GRAPH_TOPOLOGY_DEADLOCK;
      }
    }

    deps.debug?.(
      `[graph] discard: node ${node.id} discarded (${node.status}) — ${cancelledTokens} token(s), ${releasedLeases} lease(s) released; graph ${graphBlockedWith ?? 'left running'}`,
    );
    cleanupInput = { graphRunId, nodeRunId: node.id };
    return { discarded: true, cancelledTokens, releasedLeases, graphBlockedWith };
  });
  if (cleanupInput) {
    try {
      deps.cleanupNodeWorkspace(cleanupInput);
    } catch (err) {
      // Discard already committed its terminal state. Cleanup cannot turn a
      // successful explicit resolution back into a failed graph verdict.
      deps.debug?.(
        `[graph] workspace cleanup: node ${cleanupInput.nodeRunId} failed after discard (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return result;
}
