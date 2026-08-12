/**
 * The five graph transition maps (design, "Transition maps") — the testable
 * contract for the stateful graph tables. Closed-value CHECKs enforce status
 * MEMBERSHIP only; legality is THIS application code, and a pair absent from
 * its map is rejected, never guessed.
 *
 * `casStatus` is the compare-and-set primitive every graph mutation builds
 * on: a conditional UPDATE matching `WHERE id = ? AND status = ?` whose
 * affected-row count decides the outcome, so a stale caller (a second window
 * that raced the same transition) reads `false` instead of corrupting state.
 *
 * Driver-agnostic by contract: positional `?` placeholders only — the CLI
 * opens the same store with `node:sqlite`.
 */

/** The minimal driver shape both better-sqlite3 and node:sqlite satisfy. */
export interface GraphDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
}

/** Thrown for a transition pair absent from its map (an application bug). */
export class GraphStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphStoreError';
  }
}

export const GRAPH_RUN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  planning: ['awaiting-confirmation', 'running', 'cancelled', 'stale'],
  'awaiting-confirmation': ['running', 'cancelled', 'stale'],
  running: ['draining', 'blocked', 'completed-awaiting-impl-marker', 'cancelled', 'stale'],
  draining: ['running', 'completed-awaiting-impl-marker', 'cancelled', 'stale'],
  blocked: ['running', 'cancelled', 'stale'],
  'completed-awaiting-impl-marker': ['closed', 'cancelled', 'stale'],
  closed: [],
  stale: [],
  cancelled: [],
};

/**
 * Planner-run map. The design enumerates the planner-run statuses
 * (`approach_planner_runs`) but not their pairs; this map applies the same
 * doctrine the node-run rest states follow: `blocked`/`launch-unknown`/`stale`
 * are rest states with a recovery exit and a drain exit, `submitted` is
 * terminal evidence, and a late submission (a replan already won election)
 * marks the run `stale` with its snapshot discarded (design, "Immutable
 * Replanning", step on late submissions).
 */
export const PLANNER_RUN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  ready: ['launching', 'cancelled', 'stale'],
  launching: ['running', 'launch-unknown', 'cancelled', 'stale'],
  running: ['submitted', 'blocked', 'cancelled', 'stale'],
  submitted: ['stale'],
  blocked: ['launching', 'cancelled', 'stale'],
  'launch-unknown': ['cancelled'],
  stale: [],
  cancelled: [],
};

export const REVISION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  active: ['draining', 'completed', 'superseded'],
  draining: ['superseded', 'completed'],
  superseded: [],
  completed: [],
};

export const NODE_RUN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  ready: ['waiting-resource', 'launching', 'completing', 'cancelled'],
  'waiting-resource': ['ready', 'cancelled'],
  launching: ['running', 'failed-to-launch', 'launch-unknown', 'cancelled'],
  running: ['completing', 'blocked', 'stale', 'termination-unknown', 'cancelled'],
  completing: [
    'integrating',
    'running',
    'termination-unknown',
    // Slice-4 T2: the completing pipeline parks a node whose required output
    // artifacts are missing or unsafe — the effective outcome is null and no
    // edge is emitted; recovery is an explicit retry (→ launching).
    'output-artifact-missing',
    'artifact-unsafe',
    'cancelled',
  ],
  integrating: ['completed', 'blocked', 'cancelled'],
  completed: [],
  blocked: ['launching', 'cancelled'],
  'output-artifact-missing': ['launching', 'cancelled'],
  'artifact-unsafe': ['launching', 'cancelled'],
  'failed-to-launch': ['launching', 'cancelled'],
  'launch-unknown': ['cancelled'],
  'termination-unknown': ['cancelled'],
  stale: ['launching', 'cancelled'],
  cancelled: [],
};

export const TOKEN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['consumed', 'cancelled'],
  consumed: [],
  cancelled: [],
};

export const LEASE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  held: ['released', 'ambiguous-process'],
  'ambiguous-process': ['released'],
  released: [],
};

/** The graph tables whose status columns move through the maps above. */
export const STATUS_TABLES = [
  'approach_graph_runs',
  'approach_graph_revisions',
  'approach_node_runs',
  'approach_graph_tokens',
  'approach_resource_leases',
  'approach_planner_runs',
] as const;

export type TransitionMap = Readonly<Record<string, readonly string[]>>;

/**
 * Reject a transition pair absent from its map. Throws a named error; the
 * caller must never fall through to a status write after this throws.
 */
export function assertLegalTransition(
  map: TransitionMap,
  table: string,
  from: string,
  to: string,
): void {
  const allowed = map[from];
  if (!allowed || !allowed.includes(to)) {
    throw new GraphStoreError(`illegal ${table} transition: ${from} → ${to}`);
  }
}

/**
 * Compare-and-set a status column: `UPDATE … SET status = ? WHERE id = ? AND
 * status = ?`. Returns true only when exactly one row matched — a `false`
 * means the row is gone or already moved (a raced transition from another
 * window), and the caller must treat it as a no-op, never as a success.
 */
export function casStatus(
  db: GraphDb,
  table: string,
  map: TransitionMap,
  id: number,
  from: string,
  to: string,
): boolean {
  assertLegalTransition(map, table, from, to);
  const res = db
    .prepare(`UPDATE ${table} SET status = ? WHERE id = ? AND status = ?`)
    .run(to, id, from);
  return res.changes === 1;
}
