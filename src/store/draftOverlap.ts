import type { Store } from './db.js';
import { FINISHED_STAGES, listPendingProposals, NEW_NODE, projectGraph, type ProposalDependency } from './planningProposals.js';
import { formatId } from '../model/entityId.js';

/**
 * The open work a new or revised draft is compared with for overlap
 * (`@arch:DRAFT-QUALITY`): the project's pending drafts and its open,
 * non-archived tickets, minus the incoming draft and everything connected to
 * it through dependsOn / blocked-by edges (in either direction, transitively).
 * One light query for tickets, never `listTickets()`.
 */

export interface OverlapCandidate {
  /** `D<n>` (draft) or `T<n>` (ticket). */
  ref: string;
  title: string;
  description: string;
}

/** Every node reachable from `start` when each edge counts both ways. */
export function connectedNodes(edges: ReadonlyMap<string, readonly string[]>, start: string): Set<string> {
  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
  };
  for (const [from, tos] of edges) {
    for (const to of tos) {
      link(from, to);
      link(to, from);
    }
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of adjacent.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export function listOverlapCandidates(
  store: Store,
  projectId: number,
  incomingId: number | undefined,
  dependsOn: readonly ProposalDependency[],
): OverlapCandidate[] {
  const start = incomingId === undefined ? NEW_NODE : formatId('draft', incomingId);
  const linked = connectedNodes(projectGraph(store, projectId, incomingId, dependsOn), start);
  const drafts = listPendingProposals(store, projectId)
    .filter((p) => p.id !== incomingId)
    .map((p) => ({ ref: formatId('draft', p.id), title: p.payload.title, description: p.payload.description }));
  const rows = store.db
    .prepare(
      `SELECT id, title, description FROM tickets
       WHERE project_id = ? AND archived_at IS NULL
         AND (stage_current IS NULL OR stage_current NOT IN (?, ?))
       ORDER BY id`,
    )
    .all(projectId, ...FINISHED_STAGES) as { id: number; title: string; description: string | null }[];
  const tickets = rows.map((t) => ({ ref: formatId('ticket', t.id), title: t.title, description: t.description ?? '' }));
  return [...drafts, ...tickets].filter((c) => !linked.has(c.ref));
}
