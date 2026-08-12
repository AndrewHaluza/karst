/**
 * Visit allocation and loop budgets (Slice 4 Task 1).
 *
 * Every logical visit of a node in a revision — including zero-token gate and
 * join visits — gets a monotonic visit number and a distinct node-run
 * identity, and counts toward the graph-run `node_run_count` and the node's
 * own `maxVisits`. A visit beyond either budget is REFUSED before any row is
 * written: the claim transaction aborts with no mutation, so prior evidence
 * is never overwritten and a loop never silently truncates.
 *
 * `handleBudgetRefusal` is the deterministic refusal path: when the node's
 * kind has a failure outcome and the topology declares an edge for it, the
 * refusal ROUTES along that edge (the pending arrivals are cancelled and the
 * successor token is minted — a bounded deterministic outcome, never a
 * self-report). A join, or a node with no declared failure edge, blocks the
 * graph with `graph-budget-exhausted` — never routes, never silently drops.
 *
 * Host-agnostic: transaction and clock injected; no vscode, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { GRAPH_RUN_TRANSITIONS, casStatus } from '../../../store/graph/transitions.js';
import { cancelGraphToken, insertGraphToken, type GraphTokenRow } from '../../../store/graph/tokens.js';
import { parseGraphDocument } from '../parse.js';

export type BudgetRefusalReason = 'max-node-runs' | 'max-visits';

export interface BudgetRefusal {
  reason: BudgetRefusalReason;
  /** The ceiling that was exceeded. */
  limit: number;
  /** For `max-visits`: the visit that was refused. */
  visitNumber?: number;
}

/** The node kinds whose budget refusal has a bounded failure outcome. A join
 *  has only `complete`, so a join refusal can never route and always blocks. */
export const BUDGET_FAILURE_OUTCOME: Readonly<Record<string, string | null>> = {
  agent: 'blocked',
  command: 'failed',
  gate: 'not-matched',
  join: null,
};

/** The next visit number a node would allocate: MAX(visit_number) + 1. */
export function nextVisitFor(db: GraphDb, revisionId: number, nodeId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(visit_number), 0) + 1 AS next FROM approach_node_runs WHERE revision_id = ? AND node_id = ?',
    )
    .get(revisionId, nodeId) as { next: number };
  return row.next;
}

/**
 * The budget facts a refusal decision needs, read from the active revision's
 * canonical document: the document-level `maxNodeRuns` and the node's own
 * `maxVisits`. Returns null when the document cannot be parsed or the node is
 * absent — a committed revision was compile-validated, so this is a defect
 * the caller must not silently schedule against.
 */
export function budgetFactsFor(
  db: GraphDb,
  revisionId: number,
  nodeId: string,
): { maxNodeRuns: number; nodeMaxVisits: number } | null {
  const revision = db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(revisionId) as { canonical_graph: string } | undefined;
  if (!revision) return null;
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return null;
  const node = parsed.document.nodes.find((n) => n.id === nodeId);
  if (!node || node.budget.maxVisits < 1) return null;
  return { maxNodeRuns: parsed.document.budgets.maxNodeRuns, nodeMaxVisits: node.budget.maxVisits };
}

/**
 * The refusal for the NEXT visit of a node: `max-node-runs` when the graph
 * run's `node_run_count` has reached the document ceiling, `max-visits` when
 * the next visit number exceeds the node's own budget, null when within both.
 * Pure read — the caller decides whether the refusal routes or blocks.
 */
export function budgetRefusalFor(
  db: GraphDb,
  graphRunId: number,
  revisionId: number,
  nodeId: string,
): BudgetRefusal | null {
  const facts = budgetFactsFor(db, revisionId, nodeId);
  if (!facts) return null;
  const counters = db
    .prepare('SELECT node_run_count FROM approach_graph_runs WHERE id = ?')
    .get(graphRunId) as { node_run_count: number } | undefined;
  if (counters && counters.node_run_count >= facts.maxNodeRuns) {
    return { reason: 'max-node-runs', limit: facts.maxNodeRuns };
  }
  const nextVisit = nextVisitFor(db, revisionId, nodeId);
  if (nextVisit > facts.nodeMaxVisits) {
    return { reason: 'max-visits', limit: facts.nodeMaxVisits, visitNumber: nextVisit };
  }
  return null;
}

export interface BudgetRefusalDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
}

export interface BudgetRefusalInput {
  graphRunId: number;
  revisionId: number;
  nodeId: string;
  nodeKind: 'agent' | 'command' | 'gate' | 'join';
  /** The pending arrivals of the refused node — cancelled on the route path. */
  tokens: readonly GraphTokenRow[];
}

export type BudgetRefusalOutcome =
  | { kind: 'routed'; edgeId: string; destinationNodeId: string }
  | { kind: 'blocked' }
  | { kind: 'no-op' };

/** The most recent node run of the node, for anchoring a routed successor
 *  whose arrival was an entry token (no source run). */
function mostRecentNodeRunId(db: GraphDb, revisionId: number, nodeId: string): number | null {
  const row = db
    .prepare(
      'SELECT id FROM approach_node_runs WHERE revision_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(revisionId, nodeId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * The refusal path, in ONE transaction: a refused visit either routes along
 * the node's declared failure edge (arrivals cancelled, successor minted —
 * idempotent via the token uniqueness constraint) or blocks the graph with
 * `graph-budget-exhausted`. A routed successor is never anchored on the node
 * itself — a self-targeting refusal edge would re-refuse forever, so it
 * blocks instead. A raced run (no longer running) is a no-op.
 */
export function handleBudgetRefusal(
  deps: BudgetRefusalDeps,
  input: BudgetRefusalInput,
): BudgetRefusalOutcome {
  return deps.transaction(() => {
    const db = deps.db;
    const run = db
      .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
      .get(input.graphRunId) as { status: string } | undefined;
    if (!run || run.status !== 'running') return { kind: 'no-op' };

    const revision = db
      .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
      .get(input.revisionId) as { canonical_graph: string } | undefined;
    if (!revision) return { kind: 'no-op' };
    const parsed = parseGraphDocument(revision.canonical_graph);
    if (!parsed.ok) return { kind: 'no-op' };

    const outcome = BUDGET_FAILURE_OUTCOME[input.nodeKind];
    const edge = outcome
      ? parsed.document.edges.find(
          (e) => e.from === input.nodeId && e.on === outcome && e.to !== input.nodeId,
        )
      : undefined;
    if (!edge) {
      if (
        casStatus(
          db,
          'approach_graph_runs',
          GRAPH_RUN_TRANSITIONS,
          input.graphRunId,
          'running',
          'blocked',
        )
      ) {
        db.prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?').run(
          'graph-budget-exhausted',
          deps.now(),
          input.graphRunId,
        );
        deps.debug?.(
          `[graph] run ${input.graphRunId}: budget exhausted for node ${input.nodeId} (${input.nodeKind}); blocked graph-budget-exhausted`,
        );
        return { kind: 'blocked' };
      }
      return { kind: 'no-op' };
    }

    let cancelled = 0;
    for (const token of input.tokens) {
      if (cancelGraphToken(db, token.id)) cancelled += 1;
    }
    if (cancelled === 0) return { kind: 'no-op' };
    const first = input.tokens[0]!;
    // Anchor on the arrival's source run; an entry arrival has none, so the
    // node's own most recent run (which must exist — a refusal implies prior
    // visits) carries the successor.
    const sourceNodeRunId = first.source_node_run_id ?? mostRecentNodeRunId(db, input.revisionId, input.nodeId);
    if (sourceNodeRunId === null) return { kind: 'blocked' };
    const destination = edge.to === 'END' ? 'END' : edge.to;
    insertGraphToken(db, {
      revisionId: input.revisionId,
      sourceNodeRunId,
      isEntry: false,
      edgeId: edge.id,
      destinationNodeId: destination,
      destinationEnd: edge.to === 'END',
      forkInstance: first.fork_instance,
      forkLineage: first.fork_lineage,
      now: deps.now(),
    });
    deps.debug?.(
      `[graph] run ${input.graphRunId}: budget exhausted for node ${input.nodeId}; routed ${edge.on} → ${destination}`,
    );
    return { kind: 'routed', edgeId: edge.id, destinationNodeId: destination };
  });
}
