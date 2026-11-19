/**
 * The agent identity of one graph run (T1258, @arch:GRAPHRUN).
 *
 * A graph run snapshots the RESOLVED identity (provider, model, effort, source)
 * of each graph role (expert, worker, fast) when it starts. Every planner,
 * replan, node, retry and autorecovery launch of the run reads that snapshot,
 * so a Settings change cannot give a live run mixed cores without a question.
 * A user "switch" replaces the snapshot; a run with no snapshot (a pre-v133
 * row) resolves live, as before.
 *
 * Pure and host-agnostic: it resolves each role through the one live resolver
 * (`resolveGraphNodeProfile`), so the ticket's own core, model and effort are
 * part of the snapshot and a ticket change is detected like a Settings change.
 */

import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import {
  NO_TICKET_FIELDS,
  resolveGraphNodeProfile,
  type GraphLaunchTicketFields,
  type GraphProfileSource,
} from './profileResolver.js';

export const GRAPH_ROLES = ['expert', 'worker', 'fast'] as const;
export type GraphRole = (typeof GRAPH_ROLES)[number];

/** The version stamp of the stored JSON; a different value is read as "no snapshot". */
const SNAPSHOT_VERSION = 1;

/** One launch identity: the same three fields a launch reads, plus where they came from. */
export interface RoleIdentity {
  provider: string;
  model?: string;
  effort?: string;
  /** The rung that supplied it: the ticket, a preset slot or the approach's graph profile. */
  source: GraphProfileSource;
}

export interface GraphRunIdentities {
  v: typeof SNAPSHOT_VERSION;
  roles: Partial<Record<GraphRole, RoleIdentity>>;
}

const PROFILE_SOURCES: readonly string[] = ['ticket', 'preset', 'approach'];

function isProfileSource(value: unknown): value is GraphProfileSource {
  return typeof value === 'string' && PROFILE_SOURCES.includes(value);
}

function isGraphRole(name: string): name is GraphRole {
  return (GRAPH_ROLES as readonly string[]).includes(name);
}

/** The identity of every graph role under the given manifest and config. */
export function resolveRunIdentities(
  manifest: Manifest,
  config: GraphApproachConfig,
  ticket: GraphLaunchTicketFields = NO_TICKET_FIELDS,
): GraphRunIdentities {
  const roles: GraphRunIdentities['roles'] = {};
  for (const role of GRAPH_ROLES) {
    const identity = resolveGraphNodeProfile(manifest, config, role, ticket);
    if (identity) roles[role] = identity;
  }
  return { v: SNAPSHOT_VERSION, roles };
}

export function serializeRunIdentities(identities: GraphRunIdentities): string {
  return JSON.stringify(identities);
}

function parseRole(raw: unknown): RoleIdentity | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !isProfileSource(r.source)) return undefined;
  const out: RoleIdentity = { provider: r.provider, source: r.source };
  if (typeof r.model === 'string') out.model = r.model;
  if (typeof r.effort === 'string') out.effort = r.effort;
  return out;
}

/**
 * Parse the stored snapshot. `undefined` = no usable snapshot (null column, bad
 * JSON, another version, a wrong shape): the caller resolves live. A role name
 * this version does not know is dropped.
 */
export function parseRunIdentities(text: string | null): GraphRunIdentities | undefined {
  if (text === null) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== SNAPSHOT_VERSION || typeof obj.roles !== 'object' || obj.roles === null) return undefined;
  const rawRoles = obj.roles as Record<string, unknown>;
  const roles: GraphRunIdentities['roles'] = {};
  for (const role of GRAPH_ROLES) {
    if (rawRoles[role] === undefined) continue;
    const parsed = parseRole(rawRoles[role]);
    if (!parsed) return undefined;
    roles[role] = parsed;
  }
  return { v: SNAPSHOT_VERSION, roles };
}

function sameRole(a: RoleIdentity | undefined, b: RoleIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/** True when any role differs in provider, model, effort or presence. The source is not compared. */
export function identitiesDiffer(a: GraphRunIdentities, b: GraphRunIdentities): boolean {
  return GRAPH_ROLES.some((role) => !sameRole(a.roles[role], b.roles[role]));
}

function roleText(identity: RoleIdentity | undefined): string {
  if (!identity) return 'none';
  const model = identity.model ? `${identity.provider}/${identity.model}` : identity.provider;
  return identity.effort ? `${model} (${identity.effort})` : model;
}

/** One line naming every role: `expert claude/opus (high), worker …`. */
export function summarizeRunIdentities(identities: GraphRunIdentities): string {
  return GRAPH_ROLES.filter((role) => identities.roles[role] !== undefined)
    .map((role) => `${role} ${roleText(identities.roles[role])}`)
    .join(', ');
}

/** Only the roles that differ, as `role: old → new`, joined by `; `. Empty when none differ. */
export function identityDifference(from: GraphRunIdentities, to: GraphRunIdentities): string {
  return GRAPH_ROLES.filter((role) => !sameRole(from.roles[role], to.roles[role]))
    .map((role) => `${role}: ${roleText(from.roles[role])} → ${roleText(to.roles[role])}`)
    .join('; ');
}

/** The snapshot's identity for `profile` when it is a graph role the snapshot holds; else undefined (resolve live). */
export function pinnedProfile(snapshot: GraphRunIdentities | undefined, profile: string): RoleIdentity | undefined {
  return isGraphRole(profile) ? snapshot?.roles[profile] : undefined;
}
