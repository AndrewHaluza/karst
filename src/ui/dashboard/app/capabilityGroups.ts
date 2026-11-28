/**
 * Which agent-role identities the header's Models surface names (`@ui:UI-R22`), moved out of `HeaderMeta` (T1413) so
 * the row-2 relations and the row-1 Models button share one rule set. The visibility rules are unchanged:
 *
 * - UAT and Review show only when their provider/model differs from the implementation (already on `#agentButton`);
 * - a graph ticket's Expert / Worker / Fast always show, because the graph runs nodes on those roles, not on the
 *   implementation core;
 * - roles that share one provider/model collapse into one group, listed in role order.
 */
import type { MetaSlice } from './headerSlices.js';

// Variant 2: list only roles whose provider/model differs from implementation (already on #agentButton), grouped by identity.
export const CAP_ROLES = [
  ['uatTester', 'UAT'],
  ['review', 'Review'],
] as const;

// A graph ticket runs its nodes on these roles, not on the implementation core:
// they are always listed (no "same as implementation" omission).
export const GRAPH_CAP_ROLES = [
  ['graphExpert', 'Expert'],
  ['graphWorker', 'Worker'],
  ['graphFast', 'Fast'],
] as const;

export interface CapGroup {
  readonly full: string;
  readonly provider: string;
  readonly model: string;
  readonly roles: string[];
}

export function capabilityGroups(meta: MetaSlice): CapGroup[] {
  const impl = meta.capabilities.implementation;
  const groups = new Map<string, CapGroup>();
  const add = (id: MetaSlice['capabilities'][keyof MetaSlice['capabilities']], roleLabel: string): void => {
    if (!id || !id.provider || !id.model) return;
    const full = `${id.provider}/${id.model}`;
    const group = groups.get(full) ?? { full, provider: id.provider, model: id.model, roles: [] };
    group.roles.push(roleLabel);
    groups.set(full, group);
  };
  for (const [key, roleLabel] of CAP_ROLES) {
    const id = meta.capabilities[key];
    if (impl && id && impl.provider === id.provider && impl.model === id.model) continue;
    add(id, roleLabel);
  }
  for (const [key, roleLabel] of GRAPH_CAP_ROLES) add(meta.capabilities[key], roleLabel);
  return [...groups.values()];
}

export const modelLabel = (meta: MetaSlice, provider: string, model: string): string =>
  (meta.modelsByCore[provider] ?? []).find((m) => m && m.id === model)?.label || model;
