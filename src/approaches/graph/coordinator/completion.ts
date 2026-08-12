/**
 * Node completion and END quiescence (Slice 3 Task 9).
 *
 * `completeActivation` consumes a completed node run's claimed tokens and
 * inserts the successor tokens for its EFFECTIVE outcome (the edges whose
 * `on` matches; `to === 'END'` lands an END token; a self-loop mints the next
 * fork instance and extends the lineage). The insertion is idempotent by the
 * tokens uniqueness constraint, so a duplicated completion is a no-op, never
 * a double successor.
 *
 * `flipOnEndQuiescence` is the ONE-transaction END rule: a graph revision
 * completes only when at least one END token exists and no pending/claimed
 * non-END token, no unsatisfied join (a join's arrivals are pending tokens),
 * no completing process or integration operation (non-terminal node runs),
 * and no held ambiguous-process lease remains. The conditions are RE-READ
 * inside the same `BEGIN IMMEDIATE` transaction as the `running →
 * completed-awaiting-impl-marker` flip: a read-then-write would let a
 * concurrent window commit successor tokens in between, after which the
 * marker guard correctly refuses and no reopen path exists.
 *
 * Host-agnostic: transaction and clock injected; no vscode, no machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { casStatus, GRAPH_RUN_TRANSITIONS } from '../../../store/graph/transitions.js';
import {
  consumeGraphToken,
  insertGraphToken,
  type InsertGraphToken,
} from '../../../store/graph/tokens.js';
import { parseGraphDocument } from '../parse.js';
import { uuidv7 } from './lineage.js';

export interface CompletionDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  /** Mints the fork-execution identity (UUIDv7) for a self-loop successor.
   *  Injected by the host; defaults to the real clock (Slice 5 Task 4). */
  uuidv7?: () => string;
}

export interface QuiescenceDeps extends CompletionDeps {}

export interface CompletionResult {
  consumed: number;
  inserted: number;
}

/** The non-terminal node-run statuses that keep a graph from quiescing.
 *  Shared with the replan drain (Slice 4 Task 5) — a draining revision
 *  quiesces only when none of these remains. */
export const ACTIVE_NODE_STATUSES = [
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
  // Slice-4 T2: a node parked for missing/unsafe output artifacts has no
  // effective outcome and must keep the graph from quiescing.
  'output-artifact-missing',
  'artifact-unsafe',
  'stale',
];

interface NodeRunRow {
  revision_id: number;
  node_id: string;
  graph_run_id: number;
}

/**
 * Consume a node run's claimed tokens and insert its outcome successors, in
 * one transaction. Returns what moved; a duplicate completion moves nothing.
 */
export function completeActivation(
  deps: CompletionDeps,
  input: { nodeRunId: number; effectiveOutcome: string },
): CompletionResult {
  return deps.transaction(() => {
    const db = deps.db;
    const run = db
      .prepare('SELECT revision_id, node_id, graph_run_id FROM approach_node_runs WHERE id = ?')
      .get(input.nodeRunId) as NodeRunRow | undefined;
    if (!run) return { consumed: 0, inserted: 0 };
    const claimed = db
      .prepare(
        `SELECT id, fork_instance, fork_lineage, fork_instance_id FROM approach_graph_tokens
         WHERE claiming_node_run_id = ? AND status = 'claimed'`,
      )
      .all(input.nodeRunId) as {
      id: number;
      fork_instance: number;
      fork_lineage: string;
      fork_instance_id: string | null;
    }[];
    let consumed = 0;
    for (const token of claimed) {
      if (consumeGraphToken(db, token.id, input.nodeRunId, deps.now())) consumed += 1;
    }
    let inserted = 0;
    // A completion that consumed no claimed token is not a completion: a
    // duplicate call, or a run cancelled/discarded since the snapshot (Slice 4
    // Task 4), must never emit successors. The claimed-token CAS already moved
    // nothing; emitting an edge from a cancelled run would route the graph.
    const revision = consumed > 0
      ? (db
          .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
          .get(run.revision_id) as { canonical_graph: string } | undefined)
      : undefined;
    // Slice 4 Task 5: a draining revision's completions still consume the
    // claimed token and record the node's evidence, but suppress ALL successor
    // creation — the drain owns the continuation; the replan's N+1 resumes
    // scheduling. A drained completion must never route the old revision.
    const graphRun = db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(run.graph_run_id) as { status: string } | undefined;
    if (graphRun?.status === 'draining') return { consumed, inserted };
    if (revision) {
      const parsed = parseGraphDocument(revision.canonical_graph);
      if (parsed.ok) {
        const node = parsed.document.nodes.find((n) => n.id === run.node_id);
        if (node) {
          const consumedToken = claimed[0];
          for (const edge of parsed.document.edges) {
            if (edge.from !== node.id || edge.on !== input.effectiveOutcome) continue;
            const isLoop = edge.from === edge.to;
            const forkInstance = isLoop && consumedToken
              ? consumedToken.fork_instance + 1
              : (consumedToken?.fork_instance ?? 0);
            const forkLineage = isLoop && consumedToken
              ? `${consumedToken.fork_lineage}:${node.id}`
              : (consumedToken?.fork_lineage ?? 'root');
            // A self-loop traversal IS a fork execution: mint a fresh UUIDv7
            // identity for it. Descendant (non-loop) successors inherit the
            // fork execution's identity; entry tokens have none.
            const forkInstanceId = isLoop
              ? (deps.uuidv7?.() ?? uuidv7())
              : (consumedToken?.fork_instance_id ?? null);
            const successor = insertGraphToken(db, {
              revisionId: run.revision_id,
              sourceNodeRunId: input.nodeRunId,
              isEntry: false,
              edgeId: edge.id,
              destinationNodeId: edge.to === 'END' ? 'END' : edge.to,
              destinationEnd: edge.to === 'END',
              forkInstance,
              forkLineage,
              forkInstanceId,
              now: deps.now(),
            } satisfies InsertGraphToken);
            if (successor !== undefined) inserted += 1;
          }
        }
      }
    }
    return { consumed, inserted };
  });
}

/**
 * READ-only END-quiescence condition check (no transaction of its own): the
 * caller — the flip OR the marker guard — re-reads these inside ITS
 * transaction, so a concurrent window's committed successors block instead
 * of racing. Returns the blocking condition, or null when quiescent.
 */
export function quiescenceBlockedBy(db: GraphDb, graphRunId: number): string | null {
  const revision = db
    .prepare("SELECT id FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'")
    .get(graphRunId) as { id: number } | undefined;
  if (!revision) return 'no-revision';
  const endTokens = db
    .prepare(
      'SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE revision_id = ? AND destination_end = 1',
    )
    .get(revision.id) as { n: number };
  if (endTokens.n === 0) return 'no-end-token';
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_graph_tokens
       WHERE revision_id = ? AND destination_end = 0 AND status IN ('pending','claimed')`,
    )
    .get(revision.id) as { n: number };
  if (pending.n > 0) return 'pending-tokens';
  const active = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN (${ACTIVE_NODE_STATUSES.map(() => '?').join(',')})`,
    )
    .all(graphRunId, ...ACTIVE_NODE_STATUSES) as { n: number }[];
  if ((active[0]?.n ?? 0) > 0) return 'active-node-runs';
  const leases = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_resource_leases
       WHERE graph_run_id = ? AND status = 'ambiguous-process'`,
    )
    .get(graphRunId) as { n: number };
  if (leases.n > 0) return 'ambiguous-lease';
  return null;
}

export interface QuiescenceResult {
  flipped: boolean;
  /** The blocking condition, for a bounded diagnostic. */
  blockedBy?: string;
}

/**
 * The END-quiescence flip, as ONE transaction: every condition is re-read
 * inside it, so a concurrent window's committed successors block the flip
 * instead of racing it. Never writes or infers `passed` — the marker guard
 * is a separate surface.
 */
export function flipOnEndQuiescence(
  deps: QuiescenceDeps,
  input: { graphRunId: number },
): QuiescenceResult {
  return deps.transaction(() => {
    const db = deps.db;
    const run = db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(input.graphRunId) as { status: string } | undefined;
    if (!run || run.status !== 'running') return { flipped: false, blockedBy: 'not-running' };
    const blockedBy = quiescenceBlockedBy(db, input.graphRunId);
    if (blockedBy) return { flipped: false, blockedBy };
    if (
      !casStatus(
        db,
        'approach_graph_runs',
        GRAPH_RUN_TRANSITIONS,
        input.graphRunId,
        'running',
        'completed-awaiting-impl-marker',
      )
    ) {
      return { flipped: false, blockedBy: 'raced' };
    }
    db.prepare('UPDATE approach_graph_runs SET completed_at = ? WHERE id = ?').run(
      deps.now(),
      input.graphRunId,
    );
    return { flipped: true };
  });
}
