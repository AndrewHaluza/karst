/**
 * The ONE graph role view (AC-04): what the expert, worker and fast roles of a
 * graph approach resolve to, and which rung supplied each. Settings, the ticket
 * form, the dashboard and the sidebar read this, so a screen cannot drift from
 * a launch. It calls `resolveGraphNodeProfile` — it holds no resolution logic.
 */

import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import {
  NO_TICKET_FIELDS,
  resolveGraphNodeProfile,
  type GraphLaunchTicketFields,
  type GraphProfileSource,
  type ResolvedGraphProfile,
} from './profileResolver.js';

export const GRAPH_ROLES = ['expert', 'worker', 'fast'] as const;
export type GraphRole = (typeof GRAPH_ROLES)[number];

/** The three graph roles; `undefined` when the approach declares no such profile. */
export type GraphRoleView = Readonly<Record<GraphRole, ResolvedGraphProfile | undefined>>;

/** Resolve all three graph roles once, the way a launch does. */
export function graphRoleView(
  manifest: Manifest,
  config: GraphApproachConfig | undefined,
  ticket: GraphLaunchTicketFields = NO_TICKET_FIELDS,
): GraphRoleView {
  const of = (role: GraphRole): ResolvedGraphProfile | undefined =>
    config ? resolveGraphNodeProfile(manifest, config, role, ticket) : undefined;
  return { expert: of('expert'), worker: of('worker'), fast: of('fast') };
}

/**
 * The `graph:` block of an approach. With no id (a view that has no ticket
 * yet), the first approach that declares a graph.
 */
export function graphConfigOfApproach(
  manifest: Manifest,
  approachId?: string | null,
): GraphApproachConfig | undefined {
  const approaches = manifest.approaches ?? [];
  if (approachId === undefined) return approaches.find((a) => a.graph !== undefined)?.graph;
  if (approachId === null) return undefined;
  return approaches.find((a) => a.id === approachId)?.graph;
}

/** One graph role as a view prints it: the identity text and the rung that supplied it. */
export interface GraphRoleLine {
  readonly role: GraphRole;
  readonly text: string;
  readonly source: GraphProfileSource;
}

/** The resolved roles as printable lines, in expert → worker → fast order; unresolved roles are left out. */
export function describeGraphRoles(view: GraphRoleView): readonly GraphRoleLine[] {
  const lines: GraphRoleLine[] = [];
  for (const role of GRAPH_ROLES) {
    const p = view[role];
    if (p === undefined) continue;
    lines.push({ role, text: [p.provider, p.model, p.effort].filter(Boolean).join(' · '), source: p.source });
  }
  return lines;
}
