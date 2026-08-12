/**
 * Declared-writes resolution (Slice 3 Task 8).
 *
 * The completing pipeline validates the actual diff against the node's
 * DECLARED writes — re-derived here from the ACTIVE revision's canonical
 * graph, the same document the claim machinery compiled: an agent node's
 * `resources.writes` per repository, a command node's repository-wide writes
 * for each of its repositories. Paths are rooted at the repository root
 * within the worktree (`''` = the worktree root; a nested repoPath prefixes
 * its claims) and grouped per physical domain key.
 *
 * Host-agnostic: the repository entries (name, root, worktree path) and the
 * domain-key probe are injected; the extension resolves them from the
 * manifest and the worktrees rows.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { parseGraphDocument } from '../parse.js';

export interface ResolvedRepoEntry {
  repoName: string;
  /** The repository root within the worktree (`''` = the worktree root). */
  root: string;
  worktreePath: string;
}

export interface DomainDeclaredWrites {
  domainKey: string;
  paths: string[];
}

interface NodeRunRow {
  node_id: string;
  node_kind: string;
  graph_run_id: number;
}

/** The active revision's canonical graph for the run, or null when broken. */
function canonicalGraphOf(db: GraphDb, graphRunId: number): string | null {
  const row = db
    .prepare(
      "SELECT canonical_graph FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'",
    )
    .get(graphRunId) as { canonical_graph: string } | undefined;
  return row?.canonical_graph ?? null;
}

/**
 * The declared writes of a node run, grouped by physical domain key. An
 * empty result means "nothing declared" — any actual change set then violates.
 */
export function declaredWritesFor(
  db: GraphDb,
  nodeRunId: number,
  repos: readonly ResolvedRepoEntry[],
  domainKeyOf: (worktreePath: string) => string,
): DomainDeclaredWrites[] {
  const run = db
    .prepare('SELECT node_id, node_kind, graph_run_id FROM approach_node_runs WHERE id = ?')
    .get(nodeRunId) as NodeRunRow | undefined;
  if (!run) return [];
  const canonical = canonicalGraphOf(db, run.graph_run_id);
  if (canonical === null) return [];
  const parsed = parseGraphDocument(canonical);
  if (!parsed.ok) return [];
  const node = parsed.document.nodes.find((n) => n.id === run.node_id);
  if (!node) return [];

  const repoBy = new Map(repos.map((r) => [r.repoName, r]));
  const byDomain = new Map<string, string[]>();
  const rootClaim = '';

  const rootFor = (repoName: string): string | null => {
    const entry = repoBy.get(repoName);
    if (!entry) return null;
    const key = domainKeyOf(entry.worktreePath);
    let paths = byDomain.get(key);
    if (!paths) {
      paths = [];
      byDomain.set(key, paths);
    }
    return entry.root;
  };
  const addClaim = (repoName: string, path: string): void => {
    const entry = repoBy.get(repoName);
    if (!entry) return;
    const key = domainKeyOf(entry.worktreePath);
    let paths = byDomain.get(key);
    if (!paths) {
      paths = [];
      byDomain.set(key, paths);
    }
    const rooted = path === rootClaim ? rootClaim : entry.root === '' ? path : `${entry.root}/${path}`;
    if (!paths.includes(rooted)) paths.push(rooted);
  };

  if (node.kind === 'agent') {
    for (const claim of node.resources.writes) {
      for (const path of claim.paths) addClaim(claim.repo, path);
    }
  } else if (node.kind === 'command') {
    for (const repoId of node.repositories ?? []) {
      void rootFor(repoId);
      addClaim(repoId, rootClaim);
    }
  }

  return [...byDomain.entries()]
    .map(([domainKey, paths]) => ({ domainKey, paths: [...paths].sort() }))
    .sort((a, b) => (a.domainKey < b.domainKey ? -1 : a.domainKey > b.domainKey ? 1 : 0));
}
