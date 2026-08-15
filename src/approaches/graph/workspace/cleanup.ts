/**
 * Node execution workspace cleanup (Slice 5 Task 1).
 *
 * Attribution-first removal mirroring `removeWorktree`'s
 * `stopServersUnder`-first shape: every running `servers` row whose cwd sits
 * at/under the workspace is reaped through `runtime/serverIdentity.ts` (a
 * recorded pid is a recollection, never a handle — only `attributable` pids
 * are signalled, and a `denied` kill leaves the row truthfully `running`),
 * THEN the tree is removed and the durable per-graph-run workspace byte total
 * is negated (never below zero) in one transaction.
 *
 * A `kill-failed` reap REFUSES the removal: the tree stays — removing it
 * would orphan the very process the denied kill is still running. Every other
 * reap outcome proceeds, exactly like `removeWorktree`.
 *
 * Host-agnostic: store, transaction and probes are injected; no vscode.
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../../../store/db.js';
import { stopServersUnder, type ReapedServer } from '../../../runtime/worktreeServers.js';
import type { ProcessFacts } from '../../../runtime/serverIdentity.js';
import {
  removeWorkspacesForNode,
  releaseWorkspaceBytes,
  workspacesForNode,
} from '../../../store/graph/nodeRuns.js';

export interface CleanupNodeWorkspaceDeps {
  store: Store;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  /** OS probes for the attribution-first reap. */
  facts?: ProcessFacts;
  debug?: (message: string) => void;
}

export type CleanupNodeWorkspaceResult =
  | { kind: 'removed'; reaped: ReapedServer[]; releasedBytes: number }
  | { kind: 'no-op'; reaped?: ReapedServer[] }
  | { kind: 'kill-failed'; reaped: ReapedServer[] };

/** Release the node's ledger rows and negate the graph run's byte total. The
 *  negation is clamped at zero and tolerant of a missing run (nothing to
 *  negate there); bookkeeping must never fail a removal the caller asked for. */
function releaseLedger(
  deps: CleanupNodeWorkspaceDeps,
  graphRunId: number,
  nodeRunId: number,
  reaped: ReapedServer[],
): CleanupNodeWorkspaceResult {
  return deps.transaction(() => {
    // Re-read under the write lock. Node completion and graph-run close can
    // both observe the same terminal workspace; only the winner that removes
    // the ledger may release its bytes.
    const ledger = workspacesForNode(deps.store.db, nodeRunId);
    const releasedBytes = ledger.reduce((sum, w) => sum + w.byte_size, 0);
    if (ledger.length === 0) {
      deps.debug?.(
        `[graph] workspace cleanup: node ${nodeRunId} has no ledger rows (bytes already released)`,
      );
      return { kind: 'no-op', reaped };
    }
    removeWorkspacesForNode(deps.store.db, nodeRunId);
    if (releasedBytes > 0) releaseWorkspaceBytes(deps.store.db, graphRunId, releasedBytes);
    deps.debug?.(
      `[graph] workspace cleanup: node ${nodeRunId} released ${releasedBytes} workspace bytes`,
    );
    return { kind: 'removed', reaped, releasedBytes };
  });
}

/**
 * Remove a node run's workspace tree and its durable byte accounting. The
 * reap runs FIRST, while both the pid and the path are still known — the
 * mirror of `removeWorktree`, and the only moment a live server under the
 * workspace can still be reached.
 */
export function cleanupNodeWorkspace(
  deps: CleanupNodeWorkspaceDeps,
  input: { graphRunId: number; nodeRunId: number; cwd: string },
): CleanupNodeWorkspaceResult {
  if (!existsSync(input.cwd)) {
    // A no-op directory still negates the ledger — a recorded row whose tree
    // is already gone must not leave the byte counter inflated.
    deps.debug?.(
      `[graph] workspace cleanup: node ${input.nodeRunId} directory gone — releasing the ledger only`,
    );
    return releaseLedger(deps, input.graphRunId, input.nodeRunId, []);
  }
  // Serialize the server-row reap. Two windows may both observe the directory
  // before either removes it, but the second lock holder sees the first one's
  // stopped rows and never signals the same process twice. Filesystem removal
  // stays outside the transaction so an rm failure cannot roll a truthful
  // stopped-server row back to `running`.
  const reaped = deps.transaction(() =>
    existsSync(input.cwd)
      ? stopServersUnder(deps.store, input.cwd, {
          facts: deps.facts,
          debug: deps.debug,
        })
      : [],
  );
  if (reaped.some((r) => r.outcome === 'kill-failed')) {
    deps.debug?.(
      `[graph] workspace cleanup: node ${input.nodeRunId} refused — a process under ${input.cwd} would not die`,
    );
    return { kind: 'kill-failed', reaped };
  }
  rmSync(input.cwd, { recursive: true, force: true });
  deps.debug?.(`[graph] workspace cleanup: removed ${input.cwd}`);
  return releaseLedger(deps, input.graphRunId, input.nodeRunId, reaped);
}

/** The only node-run statuses whose workspace is no longer recoverable. */
export const TERMINAL_WORKSPACE_NODE_STATUSES = ['completed', 'cancelled'] as const;

/**
 * Clean one terminal node run's workspace root. Ledger rows record one cwd per
 * repository clone; the mandated layout puts all of them directly under the
 * same node-run root, so one cleanup stops every descendant server and removes
 * the whole workspace. Recoverable/runnable statuses are explicit no-ops.
 */
export function cleanupTerminalNodeWorkspace(
  deps: CleanupNodeWorkspaceDeps,
  input: { graphRunId: number; nodeRunId: number },
): CleanupNodeWorkspaceResult {
  const node = deps.store.db
    .prepare('SELECT graph_run_id, status FROM approach_node_runs WHERE id = ?')
    .get(input.nodeRunId) as { graph_run_id: number; status: string } | undefined;
  if (
    !node
    || node.graph_run_id !== input.graphRunId
    || !TERMINAL_WORKSPACE_NODE_STATUSES.includes(
      node.status as (typeof TERMINAL_WORKSPACE_NODE_STATUSES)[number],
    )
  ) {
    deps.debug?.(
      `[graph] workspace cleanup: node ${input.nodeRunId} is ${node?.status ?? 'missing'} — preserving recoverable workspace`,
    );
    return { kind: 'no-op' };
  }
  const rows = workspacesForNode(deps.store.db, input.nodeRunId);
  if (rows.length === 0) return { kind: 'no-op' };
  const roots = [...new Set(rows.map((row) => dirname(row.cwd)))];
  if (roots.length !== 1) {
    deps.debug?.(
      `[graph] workspace cleanup: node ${input.nodeRunId} has ${roots.length} workspace roots — refusing an ambiguous removal`,
    );
    return { kind: 'no-op' };
  }
  return cleanupNodeWorkspace(deps, { ...input, cwd: roots[0]! });
}

/** Clean every terminal node workspace left when a graph run closes. */
export function cleanupTerminalGraphRunWorkspaces(
  deps: CleanupNodeWorkspaceDeps,
  input: { graphRunId: number },
): CleanupNodeWorkspaceResult[] {
  const nodes = deps.store.db
    .prepare(
      `SELECT id FROM approach_node_runs
       WHERE graph_run_id = ? AND status IN ('completed', 'cancelled')
       ORDER BY id`,
    )
    .all(input.graphRunId) as { id: number }[];
  const results: CleanupNodeWorkspaceResult[] = [];
  for (const node of nodes) {
    try {
      results.push(
        cleanupTerminalNodeWorkspace(deps, {
          graphRunId: input.graphRunId,
          nodeRunId: node.id,
        }),
      );
    } catch (err) {
      // Run close is already committed. Cleanup is best-effort and one bad
      // workspace must not prevent the remaining terminal nodes being reaped.
      deps.debug?.(
        `[graph] workspace cleanup: node ${node.id} failed after run close (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return results;
}
