/**
 * The ONE graph role view (AC-04): what the expert, worker and fast roles of a
 * graph approach resolve to, and which rung supplied each. Settings, the ticket
 * form, the dashboard and the sidebar read this, so a screen cannot drift from
 * a launch. It calls `resolveGraphNodeProfile` — it holds no resolution logic.
 */

import type { AgentProvider, GraphApproachConfig, Manifest } from '../../manifest/types.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentProviders.js';
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
  // Pure over the list it is given, so the Settings webview can bundle it. A host caller passes
  // the manifest through `withBuiltInApproaches` first: the packaged Dynamic Graph approach is
  // only in that overlay, never in the raw manifest.
  const approaches = manifest.approaches ?? [];
  // No ticket yet: the first ENABLED approach that declares a graph (a disabled one never launches).
  if (approachId === undefined) return approaches.find((a) => a.enabled !== false && a.graph !== undefined)?.graph;
  if (approachId === null) return undefined;
  return approaches.find((a) => a.id === approachId)?.graph;
}

/** One graph role as a view prints it: the identity text and the rung that supplied it. */
export interface GraphRoleLine {
  readonly role: GraphRole;
  readonly text: string;
  readonly source: GraphProfileSource;
}

/**
 * The core's canonical name, from the shared registry (UI-R10c). Read here and
 * not from `inside/agent.ts`: that module value-imports `agentIdentity.ts`,
 * which reads the icon assets off disk with `node:fs`, and this file is bundled
 * into the Settings webview. `agentProviders.ts` is the dependency-free home of
 * the same mapping (`AGENT_PROVIDER_LABELS`), so the name is shared, not copied.
 */
function coreLabel(provider: string): string {
  const labels = AGENT_PROVIDER_LABELS as Readonly<Record<string, string | undefined>>;
  return labels[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The model's catalog label, the raw id when the catalog lacks it, else the
 * default reading — the same rule (and the same bundled catalog) as
 * `labelForModel` in `inside/agent.ts`, which this webview-bundled module
 * cannot import (see `coreLabel`).
 */
function modelLabel(provider: string, model: string | null): string {
  if (!model) return 'Agent default';
  const catalog = bundledModelCatalog()[provider as AgentProvider];
  return catalog?.find((option) => option.id === model)?.label ?? model;
}

/** The resolved roles as printable lines, in expert → worker → fast order; unresolved roles are left out. */
export function describeGraphRoles(view: GraphRoleView): readonly GraphRoleLine[] {
  const lines: GraphRoleLine[] = [];
  for (const role of GRAPH_ROLES) {
    const p = view[role];
    if (p === undefined) continue;
    // Display labels, never the raw ids (SET-35): the core name and the model
    // label are added here so every view of the roles prints the same text (AC-63).
    const text = [coreLabel(p.provider), modelLabel(p.provider, p.model ?? null), p.effort]
      .filter((part): part is string => Boolean(part))
      .join(' · ');
    lines.push({ role, text, source: p.source });
  }
  return lines;
}
