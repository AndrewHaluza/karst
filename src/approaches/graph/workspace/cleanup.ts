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
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { Store } from '../../../store/db.js';
import { stopServersUnder, type ReapedServer } from '../../../runtime/worktreeServers.js';
import type { ProcessFacts } from '../../../runtime/serverIdentity.js';
import {
  removeWorkspacesForNode,
  releaseWorkspaceBytes,
  workspacesForNode,
  type WorkspaceRow,
} from '../../../store/graph/nodeRuns.js';
import { nodeWorkspaceDir } from './provider.js';

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

interface TerminalWorkspaceNodeRow {
  graph_run_id: number;
  status: string;
  ticket_id: number;
  project_slug: string | null;
}

function safePathSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && basename(value) === value;
}

/**
 * Recover the global-storage prefix from a ledger path only after proving the
 * rest of the path is the exact authoritative layout. Every cwd must be one
 * immediate repository child of that same node root; no common-parent guess
 * is ever eligible for recursive removal.
 */
function validatedNodeWorkspaceRoot(
  node: TerminalWorkspaceNodeRow,
  nodeRunId: number,
  rows: readonly WorkspaceRow[],
): string | null {
  if (!node.project_slug || !safePathSegment(node.project_slug)) return null;
  const first = rows[0];
  if (!first || !isAbsolute(first.cwd) || normalize(first.cwd) !== first.cwd) return null;

  const candidate = dirname(first.cwd);
  const workspaceRoot = dirname(candidate);
  const graphRunRoot = dirname(workspaceRoot);
  const ticketRoot = dirname(graphRunRoot);
  const projectRoot = dirname(ticketRoot);
  const graphRoot = dirname(projectRoot);
  if (
    basename(graphRoot) !== 'graph'
    || basename(projectRoot) !== node.project_slug
    || basename(ticketRoot) !== String(node.ticket_id)
    || basename(graphRunRoot) !== String(node.graph_run_id)
    || basename(workspaceRoot) !== 'workspaces'
    || basename(candidate) !== String(nodeRunId)
  ) {
    return null;
  }

  const globalStorageRoot = dirname(graphRoot);
  const expected = nodeWorkspaceDir(
    globalStorageRoot,
    node.project_slug,
    node.ticket_id,
    node.graph_run_id,
    nodeRunId,
  );
  if (candidate !== expected) return null;

  for (const row of rows) {
    if (
      row.graph_run_id !== node.graph_run_id
      || !safePathSegment(row.repo_name)
      || !isAbsolute(row.cwd)
      || normalize(row.cwd) !== row.cwd
      || dirname(row.cwd) !== expected
      || row.cwd !== join(expected, row.repo_name)
    ) {
      return null;
    }
  }
  return expected;
}

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
    .prepare(
      `SELECT n.graph_run_id, n.status, g.ticket_id, p.slug AS project_slug
       FROM approach_node_runs n
       JOIN approach_graph_runs g ON g.id = n.graph_run_id
       JOIN tickets t ON t.id = g.ticket_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE n.id = ?`,
    )
    .get(input.nodeRunId) as TerminalWorkspaceNodeRow | undefined;
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
  const workspaceRoot = validatedNodeWorkspaceRoot(node, input.nodeRunId, rows);
  if (!workspaceRoot) {
    deps.debug?.(
      `[graph] workspace cleanup: node ${input.nodeRunId} has an invalid workspace ledger — refusing removal`,
    );
    return { kind: 'no-op' };
  }
  return cleanupNodeWorkspace(deps, { ...input, cwd: workspaceRoot });
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
