/**
 * Coordinator sweep (Slice 3 Task 2).
 *
 * A bounded periodic reconciliation re-reads canonical state and claims
 * activations — it never depends on a wake-up, so a completion that
 * committed to the database is always eventually scheduled even when its
 * callback hit a dead port. That is what makes a lost completion wake-up
 * harmless by construction (design, "Coordinator sweep").
 *
 * One tick: re-reads the graph run's status and active revision, re-parses
 * the canonical document, groups pending tokens by (destination, fork
 * instance) in token order, claims single activations, and fires a join only
 * when its full arrival set is pending. Work is bounded to
 * `MAX_SWEEP_TRANSITIONS` (≤ 100) state transitions per tick. Raced tokens
 * (claimed by another window mid-tick) are skipped, never thrown; an
 * expected partial join firing is a no-op for that group, retried next tick.
 *
 * Host-agnostic: the transaction and clock are injected; no vscode, no
 * provider, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { pendingTokensForRevision, type GraphTokenRow } from '../../../store/graph/tokens.js';
import { claimActivation, claimJoinActivation, GraphClaimError } from './claim.js';
import { parseGraphDocument, type ApproachNode, type GraphDocument } from '../parse.js';

/** The per-tick bound: ≤ 100 state transitions (design, "Coordinator sweep"). */
export const MAX_SWEEP_TRANSITIONS = 100;

export interface SweepDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;
}

export interface SweepResult {
  graphRunId: number;
  /** Single activations claimed plus joins fired. */
  claimed: number;
  /** Token status changes plus successor inserts. */
  transitions: number;
}

interface RevisionRow {
  id: number;
  canonical_graph: string;
}

interface TokenGroup {
  destination: string;
  forkInstance: number;
  tokens: GraphTokenRow[];
}

function groupPendingTokens(tokens: readonly GraphTokenRow[]): TokenGroup[] {
  const byKey = new Map<string, TokenGroup>();
  const order: string[] = [];
  for (const token of tokens) {
    if (token.destination_end) continue; // END tokens are never claimed
    const destination = token.destination_node_id!;
    const key = `${destination}\u0000${token.fork_instance}`;
    let group = byKey.get(key);
    if (!group) {
      group = { destination, forkInstance: token.fork_instance, tokens: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.tokens.push(token);
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * One reconciliation tick for one graph run. Re-reads canonical state, then
 * claims until the transition budget is spent. Returns what it moved.
 */
export function runCoordinatorTick(
  deps: SweepDeps,
  opts: { graphRunId: number; maxTransitions?: number },
): SweepResult {
  const maxTransitions = opts.maxTransitions ?? MAX_SWEEP_TRANSITIONS;
  const db = deps.db;
  const result: SweepResult = { graphRunId: opts.graphRunId, claimed: 0, transitions: 0 };

  const run = db
    .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
    .get(opts.graphRunId) as { status: string } | undefined;
  if (!run || run.status !== 'running') return result;

  const revision = db
    .prepare(
      "SELECT id, canonical_graph FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'",
    )
    .get(opts.graphRunId) as RevisionRow | undefined;
  if (!revision) return result;

  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) {
    // A committed revision was compile-validated; failing to re-parse is a
    // defect worth a bounded diagnostic, and a tick can safely do nothing.
    deps.debug?.(
      `[graph] run ${opts.graphRunId} revision ${revision.id} failed to re-parse (${parsed.diagnostics[0]?.code ?? 'unknown'})`,
    );
    return result;
  }
  const document = parsed.document;
  const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
  const joinArrivalEdges = new Map<string, string[]>();
  const joinOutgoing = new Map<string, { edgeId: string; destination: string; end: boolean }>();
  for (const node of document.nodes) {
    if (node.kind !== 'join') continue;
    // Arrivals are the branch→join edges — "predecessor equality: incoming
    // edges are exactly the declared branches" is compile-checked, so the
    // join's incoming edges ARE its arrival set.
    joinArrivalEdges.set(
      node.id,
      document.edges.filter((e) => e.to === node.id).map((e) => e.id),
    );
    const outgoing = document.edges.find((e) => e.from === node.id);
    if (outgoing) {
      joinOutgoing.set(node.id, {
        edgeId: outgoing.id,
        destination: outgoing.to === 'END' ? 'END' : outgoing.to,
        end: outgoing.to === 'END',
      });
    }
  }

  const pending = pendingTokensForRevision(db, revision.id);
  for (const group of groupPendingTokens(pending)) {
    if (result.transitions >= maxTransitions) break;
    const node = nodesById.get(group.destination) as ApproachNode | undefined;
    if (!node) {
      deps.debug?.(`[graph] run ${opts.graphRunId}: pending token for unknown node ${group.destination}`);
      continue;
    }
    if (node.kind === 'join') {
      const arrivalEdges = joinArrivalEdges.get(node.id) ?? [];
      const complete = arrivalEdges.length === group.tokens.length
        && arrivalEdges.every((edgeId) => group.tokens.some((t) => t.edge_id === edgeId));
      if (!complete) continue; // the join waits for its whole arrival set
      const outgoing = joinOutgoing.get(node.id);
      if (!outgoing) {
        deps.debug?.(`[graph] run ${opts.graphRunId}: join ${node.id} has no outgoing edge`);
        continue;
      }
      const cost = group.tokens.length + 1; // arrivals + successor token
      if (result.transitions + cost > maxTransitions) break;
      try {
        claimJoinActivation(
          { db, transaction: deps.transaction, now: deps.now },
          {
            tokenIds: group.tokens.map((t) => t.id),
            outgoing: {
              edgeId: outgoing.edgeId,
              destinationNodeId: outgoing.destination,
              destinationEnd: outgoing.end,
              forkInstance: group.forkInstance,
              forkLineage: group.tokens[0]!.fork_lineage,
            },
          },
        );
        result.claimed += 1;
        result.transitions += cost;
      } catch (err) {
        if (err instanceof GraphClaimError) {
          deps.debug?.(`[graph] run ${opts.graphRunId}: join ${node.id} firing aborted: ${err.message}`);
        } else {
          throw err;
        }
      }
      continue;
    }
    for (const token of group.tokens) {
      if (result.transitions >= maxTransitions) break;
      const outcome = claimActivation(
        { db, transaction: deps.transaction, now: deps.now },
        {
          tokenId: token.id,
          nodeKind: node.kind === 'agent' ? 'agent' : node.kind === 'command' ? 'command' : 'gate',
          profileIsExpert: node.kind === 'agent' && node.profile === 'expert',
        },
      );
      if (outcome.claimed) {
        result.claimed += 1;
        result.transitions += 1;
      }
    }
  }
  return result;
}

/** All graph runs currently eligible for scheduling. */
export function activeGraphRunIds(db: GraphDb): number[] {
  const rows = db
    .prepare("SELECT id FROM approach_graph_runs WHERE status = 'running' ORDER BY id")
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}
