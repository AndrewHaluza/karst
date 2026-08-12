/**
 * Gate node executor (Slice 3 Task 4).
 *
 * Evaluates the CLOSED predicate set over persisted state — node visit
 * counts, node outcome counts, expert-run counts, `artifact-exists`, and
 * `all`/`any` composition — with the closed comparison operators. No
 * JavaScript, shell, SQL, regex, or model-generated expression executes:
 * the predicate is a closed union (`GatePredicate`) and the evaluator is a
 * total function over it. Outputs are always `matched`/`not-matched`; both
 * require outgoing edges (the compiler enforces that at compile time).
 *
 * Gate visits cost zero tokens and still count toward `maxNodeRuns` and the
 * node's `maxVisits` (the claim transaction already creates the visit).
 *
 * Host-agnostic: state arrives through the injected `GateState`, and
 * `gateStateFromStore` is the store-bound reader the coordinator supplies.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import type { ComparisonOperator, GatePredicate } from '../parse.js';

export type GateVerdict = 'matched' | 'not-matched';

/** The persisted facts a gate reads — injected so the evaluator is pure. */
export interface GateState {
  nodeVisitCount(nodeId: string): number;
  nodeOutcomeCount(nodeId: string, outcome: string): number;
  expertRunCount(): number;
  artifactExists(artifactId: string): boolean;
}

const COMPARATORS: Readonly<Record<ComparisonOperator, (actual: number, expected: number) => boolean>> = {
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  gte: (a, b) => a >= b,
  gt: (a, b) => a > b,
};

function compare(actual: number, op: ComparisonOperator, expected: number): boolean {
  return COMPARATORS[op](actual, expected);
}

/** Total over the closed predicate union — a new predicate needs a case here. */
export function evaluateGatePredicate(predicate: GatePredicate, state: GateState): boolean {
  switch (predicate.kind) {
    case 'node-visits':
      return compare(state.nodeVisitCount(predicate.node), predicate.op, predicate.value);
    case 'node-outcomes':
      return compare(
        state.nodeOutcomeCount(predicate.node, predicate.outcome),
        predicate.op,
        predicate.value,
      );
    case 'expert-runs':
      return compare(state.expertRunCount(), predicate.op, predicate.value);
    case 'artifact-exists':
      return state.artifactExists(predicate.artifact);
    case 'all':
      return predicate.predicates.every((p) => evaluateGatePredicate(p, state));
    case 'any':
      return predicate.predicates.some((p) => evaluateGatePredicate(p, state));
  }
}

export function evaluateGate(predicate: GatePredicate, state: GateState): GateVerdict {
  return evaluateGatePredicate(predicate, state) ? 'matched' : 'not-matched';
}

/**
 * The store-bound reader: visit counts and outcome counts per node over the
 * revision's node runs, the graph run's expert counter, and artifact
 * existence over the run's immutable instances.
 */
export function gateStateFromStore(db: GraphDb, graphRunId: number, revisionId: number): GateState {
  const visitCount = (nodeId: string): number =>
    (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM approach_node_runs WHERE revision_id = ? AND node_id = ?',
        )
        .get(revisionId, nodeId) as { n: number }
    ).n;
  const outcomeCount = (nodeId: string, outcome: string): number =>
    (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM approach_node_runs WHERE revision_id = ? AND node_id = ? AND outcome = ?',
        )
        .get(revisionId, nodeId, outcome) as { n: number }
    ).n;
  const expertRuns = (): number =>
    (
      db
        .prepare('SELECT expert_run_count AS n FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { n: number }
    ).n;
  const artifactExists = (artifactId: string): boolean =>
    db
      .prepare(
        'SELECT 1 AS x FROM approach_artifact_instances WHERE graph_run_id = ? AND artifact_id = ? LIMIT 1',
      )
      .get(graphRunId, artifactId) !== undefined;
  return {
    nodeVisitCount: visitCount,
    nodeOutcomeCount: outcomeCount,
    expertRunCount: expertRuns,
    artifactExists,
  };
}
