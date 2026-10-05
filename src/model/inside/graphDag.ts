/**
 * The graph DAG strip projection: the active revision's topology laid out
 * host-side as columns by dependency depth (UI-R31 — the webview never
 * computes layout). Pure and cycle-safe; every text field is sanitized.
 */

import { sanitizeGraphText } from './graphText.js';
import type { GraphDagChip, GraphDagView, GraphNodeListRow } from './types.js';

export interface GraphTopology {
  nodes: readonly { id: string }[];
  edges: readonly { from: string; to: string }[];
}

export const DAG_MAX_COLUMNS = 12;
export const DAG_MAX_CHIPS = 40;

/** Drop back-edges (and self-loops) so the rest is acyclic; iterative DFS. */
function forwardEdges(ids: readonly string[], edges: readonly { from: string; to: string }[]): Map<string, string[]> {
  const known = new Set(ids);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const seenEdge = new Set<string>();
  const hasIn = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}\u0000${e.to}`;
    if (known.has(e.from) && known.has(e.to) && e.from !== e.to && !seenEdge.has(key)) {
      seenEdge.add(key);
      out.get(e.from)!.push(e.to);
      hasIn.add(e.to);
    }
  }
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const keep = new Map<string, string[]>(ids.map((id) => [id, []]));
  const roots = [...ids.filter((id) => !hasIn.has(id)), ...ids];
  for (const root of roots) {
    if (state.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const targets = out.get(top.id)!;
      if (top.next >= targets.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const to = targets[top.next++]!;
      if (state.get(to) === 1) continue; // back-edge
      keep.get(top.id)!.push(to);
      if (!state.has(to)) {
        state.set(to, 1);
        stack.push({ id: to, next: 0 });
      }
    }
  }
  return keep;
}

/** Longest-path depth over the acyclic edge set (Kahn order). */
function depths(ids: readonly string[], fwd: Map<string, string[]>): Map<string, number> {
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const tos of fwd.values()) for (const t of tos) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const to of fwd.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(id) ?? 0) + 1));
      indeg.set(to, (indeg.get(to) ?? 0) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return depth;
}

function chipFor(label: string, latest: GraphNodeListRow | undefined): GraphDagChip {
  if (!latest) return { id: label, label, displayStatus: 'pending', state: 'pending' };
  const state =
    latest.entry === 'deferred' ? 'deferred' : sanitizeGraphText(latest.age ?? latest.status);
  return { id: label, label, displayStatus: latest.displayStatus, state };
}

export function graphDagView(
  topology: GraphTopology,
  ledger: readonly GraphNodeListRow[],
): GraphDagView {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const n of topology.nodes) {
    const id = sanitizeGraphText(n.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const edges = topology.edges.map((e) => ({ from: sanitizeGraphText(e.from), to: sanitizeGraphText(e.to) }));
  const depth = depths(ids, forwardEdges(ids, edges));

  const latestByNode = new Map<string, GraphNodeListRow>();
  let planner: GraphNodeListRow | undefined;
  for (const row of ledger) {
    if (row.entry === 'planner') planner = row;
    else latestByNode.set(sanitizeGraphText(row.nodeId), row);
  }

  const cols: GraphDagChip[][] = [];
  if (planner) cols.push([chipFor(sanitizeGraphText(planner.nodeId), planner)]);
  const offset = cols.length;
  for (const id of ids) {
    const c = (depth.get(id) ?? 0) + offset;
    while (cols.length <= c) cols.push([]);
    cols[c]!.push(chipFor(id, latestByNode.get(id)));
  }
  const nonEmpty = cols.filter((c) => c.length > 0);

  let budget = DAG_MAX_CHIPS;
  let dropped = 0;
  const columns: GraphDagChip[][] = [];
  for (const [i, col] of nonEmpty.entries()) {
    if (i >= DAG_MAX_COLUMNS || budget <= 0) {
      dropped += col.length;
      continue;
    }
    const shown = col.slice(0, budget);
    budget -= shown.length;
    dropped += col.length - shown.length;
    columns.push(shown);
  }
  return { columns, ...(dropped > 0 ? { more: `+${dropped} more` } : {}) };
}
