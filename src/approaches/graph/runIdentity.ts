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
 * (`resolveGraphNodeProfile`), so the ticket's `agentPreset` is part of the
 * snapshot and a ticket preset change is detected like a Settings change. A
 * stored `source: 'ticket'` is legacy only: a snapshot written before AC-63.
 *
 * T1386: a role may also pin an ACCOUNT of its core (`account?: string`). Only
 * the user's Pick account at a graph usage-limit park writes it; a quota stop
 * never switches by itself (@arch:AC-55). An absent field means the active
 * account, and the field takes no part in `identitiesDiffer`: Settings has no
 * account per role, so a pick must never raise the Keep/Switch question.
 */

import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import { validateAccountName } from '../../agent/accounts/types.js';
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

/** A stored rung: a live one, or `'ticket'` in a snapshot written before AC-63 (legacy only). */
export type StoredGraphProfileSource = GraphProfileSource | 'ticket';

/** One launch identity: the same three fields a launch reads, plus where they came from. */
export interface RoleIdentity {
  provider: string;
  model?: string;
  effort?: string;
  /** The rung that supplied it: a preset slot, the approach's graph profile, or the legacy ticket rung. */
  source: StoredGraphProfileSource;
  /**
   * The account this role runs under when the user picked one at a graph
   * usage-limit park (@arch:AC-55, T1386). Absent = the active account of the
   * core. Only a user pick writes it; a quota stop never switches by itself.
   */
  account?: string;
}

export interface GraphRunIdentities {
  v: typeof SNAPSHOT_VERSION;
  roles: Partial<Record<GraphRole, RoleIdentity>>;
}

const PROFILE_SOURCES: readonly string[] = ['ticket', 'preset', 'approach'];

function isProfileSource(value: unknown): value is StoredGraphProfileSource {
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

function parseRole(raw: unknown, role: GraphRole, debug?: (message: string) => void): RoleIdentity | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !isProfileSource(r.source)) return undefined;
  const out: RoleIdentity = { provider: r.provider, source: r.source };
  if (typeof r.model === 'string') out.model = r.model;
  if (typeof r.effort === 'string') out.effort = r.effort;
  // Validate the stored JSON: a name that is not a safe account slug (or the
  // reserved `default`, which means NO override) is dropped, the role is kept.
  if (r.account !== undefined) {
    const problem = validateAccountName(r.account);
    if (problem === null) out.account = r.account as string;
    else debug?.(`[process] graph run snapshot: role "${role}" has an unsafe account name — dropped (${problem})`);
  }
  return out;
}

/**
 * Parse the stored snapshot. `undefined` = no usable snapshot (null column, bad
 * JSON, another version, a wrong shape): the caller resolves live. A role name
 * this version does not know is dropped. An unsafe `account` is dropped with
 * one debug line; the role keeps its provider/model/effort.
 */
export function parseRunIdentities(
  text: string | null,
  debug?: (message: string) => void,
): GraphRunIdentities | undefined {
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
    const parsed = parseRole(rawRoles[role], role, debug);
    if (!parsed) return undefined;
    roles[role] = parsed;
  }
  return { v: SNAPSHOT_VERSION, roles };
}

function sameRole(a: RoleIdentity | undefined, b: RoleIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

/** True when any role differs in provider, model, effort or presence. The
 *  source and the pinned account are not compared: Settings has no account per
 *  role, so a pick must never make the Settings scan ask Keep/Switch. */
export function identitiesDiffer(a: GraphRunIdentities, b: GraphRunIdentities): boolean {
  return GRAPH_ROLES.some((role) => !sameRole(a.roles[role], b.roles[role]));
}

function roleText(identity: RoleIdentity | undefined): string {
  if (!identity) return 'none';
  const model = identity.model ? `${identity.provider}/${identity.model}` : identity.provider;
  const named = identity.account ? `${model}@${identity.account}` : model;
  return identity.effort ? `${named} (${identity.effort})` : named;
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
