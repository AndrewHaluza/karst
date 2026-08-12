/**
 * The claim transaction (Slice 3 Task 1).
 *
 * Claiming is transactionally single-winner across windows: in one
 * `BEGIN IMMEDIATE` transaction Karst conditionally changes a token from
 * `pending` to `claimed`, creates its node-run visit, reserves graph/node/
 * expert budgets, and stores the claiming run. Scheduling continues only when
 * exactly the expected number of rows changed — 1 for a single activation,
 * `|waitFor|` for a join firing, which is all-or-nothing: any arrival that is
 * not claimable aborts the whole firing with no partial claim, and the
 * coordinator retries next tick. External launch happens after commit, never
 * inside the transaction.
 *
 * Lock liveness: a contended `BEGIN IMMEDIATE` in the extension host aborts
 * immediately (the connection must run with a zero busy timeout), because a
 * synchronous wait blocks the shared event loop; the aborted claim counts
 * nothing and mutates nothing. The `transaction` dependency is injected so
 * the host hands the coordinator an immediate, non-waiting wrapper.
 *
 * A launch retry never re-claims: the token stays `claimed`, the reserved
 * node run is reused, and `incrementLaunchAttempt` bumps the launch-attempt
 * counter — there is no `claimed → pending` transition.
 *
 * Physical-domain lease acquisition and the concurrency-slot reservation join
 * this transaction with the workspace/lease machinery (Slices 4–5); the
 * transaction shape already accommodates them.
 *
 * Host-agnostic: no vscode, no provider, no stage machine.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import {
  graphTokenById,
  insertGraphToken,
  claimGraphToken,
  type GraphTokenRow,
} from '../../../store/graph/tokens.js';

/** Thrown when a claim must abort: a join with an unclaimable arrival, an
 *  END token handed to claiming, or an inner CAS that changed no row. */
export class GraphClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphClaimError';
  }
}

export interface ClaimDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped and all-or-nothing; a throw rolls back. In the
   *  extension host this is a zero-busy-timeout immediate transaction. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
}

export type ClaimResult =
  | { claimed: true; nodeRunId: number; visitNumber: number }
  | { claimed: false; reason: 'not-found' | 'not-pending' };

export interface ClaimActivationInput {
  tokenId: number;
  nodeKind: 'agent' | 'command' | 'gate';
  /** Agent nodes whose resolved profile is `expert` reserve the expert budget. */
  profileIsExpert?: boolean;
}

export interface JoinOutgoing {
  edgeId: string;
  destinationNodeId: string;
  destinationEnd: boolean;
  forkInstance: number;
  forkLineage: string | null;
}

export interface ClaimJoinInput {
  /** The join's correlated arrivals — one per declared predecessor. */
  tokenIds: readonly number[];
  outgoing: JoinOutgoing;
}

interface RevisionRow {
  graph_run_id: number;
}

function revisionGraphRunId(db: GraphDb, revisionId: number): number {
  const row = db
    .prepare('SELECT graph_run_id FROM approach_graph_revisions WHERE id = ?')
    .get(revisionId) as RevisionRow | undefined;
  if (!row) throw new GraphClaimError(`unknown revision ${revisionId}`);
  return row.graph_run_id;
}

function nextVisitNumber(db: GraphDb, revisionId: number, nodeId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(visit_number), 0) + 1 AS next FROM approach_node_runs WHERE revision_id = ? AND node_id = ?',
    )
    .get(revisionId, nodeId) as { next: number };
  return row.next;
}

function createNodeRun(
  db: GraphDb,
  graphRunId: number,
  revisionId: number,
  nodeId: string,
  nodeKind: string,
  visitNumber: number,
): number {
  const res = db
    .prepare(
      `INSERT INTO approach_node_runs
         (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, ?, 'ready')`,
    )
    .run(graphRunId, revisionId, nodeId, nodeKind, visitNumber);
  return Number(res.lastInsertRowid);
}

function reserveBudgets(db: GraphDb, graphRunId: number, now: string, expert: boolean): void {
  db.prepare(
    'UPDATE approach_graph_runs SET node_run_count = node_run_count + 1, updated_at = ? WHERE id = ?',
  ).run(now, graphRunId);
  if (expert) {
    db.prepare(
      'UPDATE approach_graph_runs SET expert_run_count = expert_run_count + 1, updated_at = ? WHERE id = ?',
    ).run(now, graphRunId);
  }
}

function allArrivalsClaimable(db: GraphDb, tokenIds: readonly number[]): GraphTokenRow[] {
  if (tokenIds.length === 0) throw new GraphClaimError('join firing with zero arrivals');
  const tokens: GraphTokenRow[] = [];
  for (const id of tokenIds) {
    const token = graphTokenById(db, id);
    if (!token) throw new GraphClaimError(`partial claim: unknown arrival token ${id}`);
    if (token.status !== 'pending') {
      throw new GraphClaimError(`partial claim: arrival token ${id} is ${token.status}, not pending`);
    }
    tokens.push(token);
  }
  const first = tokens[0]!;
  if (first.destination_end) throw new GraphClaimError('join arrivals may not target END');
  for (const token of tokens) {
    if (token.revision_id !== first.revision_id || token.destination_node_id !== first.destination_node_id) {
      throw new GraphClaimError('join arrivals disagree on revision or destination');
    }
  }
  return tokens;
}

/**
 * Claim one activation: token `pending → claimed`, its node-run visit
 * created (or, on the recovery path, its reserved run reused), budgets
 * reserved, the claiming run stored. Returns a no-op when the token is gone
 * or already claimed — a raced second window never throws and never mutates.
 */
export function claimActivation(deps: ClaimDeps, input: ClaimActivationInput): ClaimResult {
  return deps.transaction(() => {
    const db = deps.db;
    const token = graphTokenById(db, input.tokenId);
    if (!token) return { claimed: false, reason: 'not-found' };
    if (token.status !== 'pending') return { claimed: false, reason: 'not-pending' };
    if (token.destination_end) {
      throw new GraphClaimError(`token ${token.id} targets END and is never claimed`);
    }
    const graphRunId = revisionGraphRunId(db, token.revision_id);
    const nodeId = token.destination_node_id!;
    const visitNumber = nextVisitNumber(db, token.revision_id, nodeId);
    const nodeRunId = createNodeRun(db, graphRunId, token.revision_id, nodeId, input.nodeKind, visitNumber);
    if (!claimGraphToken(db, token.id, nodeRunId)) {
      // The row-count check: exactly one row must change. We hold the write
      // lock, so this can only be an application bug — abort, never continue.
      throw new GraphClaimError(`claim CAS moved no row for token ${token.id}`);
    }
    reserveBudgets(db, graphRunId, deps.now(), input.profileIsExpert === true);
    return { claimed: true, nodeRunId, visitNumber };
  });
}

/**
 * Fire a join: an all-or-nothing claim of every correlated arrival, the join
 * visit, and the successor token — in one transaction, or not at all. The
 * exact-row check is `|waitFor|`: any arrival that is not claimable throws,
 * the transaction rolls back, and the coordinator retries next tick.
 */
export function claimJoinActivation(deps: ClaimDeps, input: ClaimJoinInput): ClaimResult {
  return deps.transaction(() => {
    const db = deps.db;
    const arrivals = allArrivalsClaimable(db, input.tokenIds);
    const first = arrivals[0]!;
    const graphRunId = revisionGraphRunId(db, first.revision_id);
    const joinNodeId = first.destination_node_id!;
    const visitNumber = nextVisitNumber(db, first.revision_id, joinNodeId);
    const nodeRunId = createNodeRun(db, graphRunId, first.revision_id, joinNodeId, 'join', visitNumber);
    let changed = 0;
    for (const token of arrivals) {
      if (claimGraphToken(db, token.id, nodeRunId)) changed++;
    }
    if (changed !== arrivals.length) {
      throw new GraphClaimError(
        `partial claim: ${changed}/${arrivals.length} arrivals claimed; aborting the join firing`,
      );
    }
    const successorId = insertGraphToken(db, {
      revisionId: first.revision_id,
      sourceNodeRunId: nodeRunId,
      isEntry: false,
      edgeId: input.outgoing.edgeId,
      destinationNodeId: input.outgoing.destinationNodeId,
      destinationEnd: input.outgoing.destinationEnd,
      forkInstance: input.outgoing.forkInstance,
      forkLineage: input.outgoing.forkLineage,
      now: deps.now(),
    });
    if (successorId === undefined) {
      throw new GraphClaimError('duplicate successor token on join firing');
    }
    reserveBudgets(db, graphRunId, deps.now(), false);
    return { claimed: true, nodeRunId, visitNumber };
  });
}

export interface NodeRunRow {
  id: number;
  graph_run_id: number;
  revision_id: number;
  node_id: string;
  node_kind: string;
  visit_number: number;
  status: string;
  launch_attempt: number;
}

/** The reserved run behind a claimed token — the retry's only handle. */
export function claimedNodeRunForToken(db: GraphDb, tokenId: number): NodeRunRow | undefined {
  return db
    .prepare(
      `SELECT r.* FROM approach_node_runs r
       JOIN approach_graph_tokens t ON t.claiming_node_run_id = r.id
       WHERE t.id = ?`,
    )
    .get(tokenId) as NodeRunRow | undefined;
}

/** A launch retry bumps the attempt counter on the reserved run; it never
 *  creates another logical visit and never re-pends the token. */
export function incrementLaunchAttempt(db: GraphDb, nodeRunId: number): boolean {
  const res = db
    .prepare('UPDATE approach_node_runs SET launch_attempt = launch_attempt + 1 WHERE id = ?')
    .run(nodeRunId);
  return res.changes === 1;
}
