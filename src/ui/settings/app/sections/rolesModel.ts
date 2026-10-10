/**
 * The Agents page's Roles-tab model: what a role EFFECTIVELY runs on and where
 * that value comes from, and the one rule for where an edit lands.
 *
 * Mirrors the resolver's order (`resolveProcessAssignment` /
 * `resolvePresetDefaults`) for the draft being edited, with no ticket layer:
 *   pin (`processes.<role>` with `pinned: true`) → the selected preset's slot →
 *   the Default row (`agentProvider` / `defaultModel` / `defaultEffort`).
 *
 * An edit always lands in the layer that wins: the pin when the role is
 * pinned, otherwise the selected preset — so an edit can never be dead.
 *
 * Only the seven process roles can carry a pin: a pin lives on a
 * `processes.<key>` row and there is no such row for implementation or the
 * graph roles.
 *
 * Pure and immutable: every writer returns a new manifest.
 */
import type { AgentPreset, Manifest } from '../../../../manifest/types.js';
import { PROCESS_KEYS, type ProcessKey } from '../../../../manifest/validate/processAssignments.js';

export type RoleSource = 'pin' | 'preset' | 'default';

/** A role's core/model/effort as the picker edits it; '' is "unset". */
export interface RoleValue {
  readonly core: string;
  readonly model: string;
  readonly effort: string;
}

export interface EffectiveRole extends RoleValue {
  readonly source: RoleSource;
}

const EMPTY: RoleValue = { core: '', model: '', effort: '' };

/** The process key a capability pins on, or undefined (implementation, graph roles). */
export function pinKeyOf(capability: string): ProcessKey | undefined {
  return (PROCESS_KEYS as readonly string[]).includes(capability) ? (capability as ProcessKey) : undefined;
}

function processRow(draft: Manifest, key: ProcessKey): Record<string, unknown> {
  return { ...((draft.processes?.[key] ?? {}) as Record<string, unknown>) };
}

/** The role's pin, when it is pinned and carries a core. */
export function pinOf(draft: Manifest, capability: string): RoleValue | undefined {
  const key = pinKeyOf(capability);
  const row = key === undefined ? undefined : draft.processes?.[key];
  if (row?.pinned !== true || !row.provider) return undefined;
  return { core: row.provider, model: row.model ?? '', effort: row.effort ?? '' };
}

/** The preset's own slot for the role (a legacy flat preset is one slot on every role). */
export function slotOf(draft: Manifest, presetName: string | null, capability: string): RoleValue | undefined {
  if (presetName === null || !Object.prototype.hasOwnProperty.call(draft.agentPresets ?? {}, presetName)) {
    return undefined;
  }
  const preset = (draft.agentPresets ?? {})[presetName] as AgentPreset & {
    provider?: string;
    model?: string;
    effort?: string;
  };
  const slot =
    preset.provider !== undefined || preset.model !== undefined
      ? { provider: preset.provider, model: preset.model, effort: preset.effort }
      : preset.slots?.[capability as keyof AgentPreset['slots']];
  return slot?.provider ? { core: slot.provider, model: slot.model ?? '', effort: slot.effort ?? '' } : undefined;
}

/** The Default row: what a role with no pin and no preset slot runs on. */
export function defaultRow(draft: Manifest): RoleValue {
  return {
    core: draft.agentProvider ?? '',
    model: draft.defaultModel ?? '',
    effort: draft.defaultEffort ?? '',
  };
}

export function effectiveRole(draft: Manifest, presetName: string | null, capability: string): EffectiveRole {
  const pin = pinOf(draft, capability);
  if (pin) return { ...pin, source: 'pin' };
  const slot = slotOf(draft, presetName, capability);
  if (slot) return { ...slot, source: 'preset' };
  return { ...defaultRow(draft), source: 'default' };
}

/** Roles whose EFFECTIVE value differs between two presets (pins are the same in both). */
export function differingRoles(
  draft: Manifest,
  a: string | null,
  b: string | null,
  capabilities: readonly string[],
): readonly string[] {
  return capabilities.filter((cap) => {
    const x = effectiveRole(draft, a, cap);
    const y = effectiveRole(draft, b, cap);
    return x.core !== y.core || x.model !== y.model || x.effort !== y.effort;
  });
}

function withProcessRow(draft: Manifest, key: ProcessKey, row: Record<string, unknown> | undefined): Manifest {
  const processes = { ...((draft.processes ?? {}) as Record<string, unknown>) };
  if (row === undefined || Object.keys(row).length === 0) delete processes[key];
  else processes[key] = row;
  const next: Manifest = { ...draft };
  if (Object.keys(processes).length > 0) next.processes = processes as Manifest['processes'];
  else delete next.processes;
  return next;
}

function withSlot(draft: Manifest, presetName: string, capability: string, slot: RoleValue | undefined): Manifest {
  const preset = (draft.agentPresets ?? {})[presetName] as (AgentPreset & { provider?: string; model?: string; effort?: string }) | undefined;
  if (preset === undefined) return draft;
  const legacy = preset.provider !== undefined || preset.model !== undefined;
  const base: Record<string, { provider: string; model: string; effort?: string }> = {};
  if (legacy) {
    // A legacy flat preset is one slot on every role; expand it on the way out.
    for (const cap of ALL_CAPABILITIES) {
      base[cap] = { provider: preset.provider ?? '', model: preset.model ?? '', ...(preset.effort ? { effort: preset.effort } : {}) };
    }
  } else {
    Object.assign(base, preset.slots);
  }
  if (slot === undefined) delete base[capability];
  else base[capability] = { provider: slot.core, model: slot.model, ...(slot.effort ? { effort: slot.effort } : {}) };
  const next: AgentPreset = {
    ...(preset.label === undefined ? {} : { label: preset.label }),
    slots: base as AgentPreset['slots'],
  };
  return { ...draft, agentPresets: { ...(draft.agentPresets ?? {}), [presetName]: next } };
}

const ALL_CAPABILITIES = [
  'uatTester', 'uatFix', 'review', 'reviewFix', 'prDescription', 'ticketAnalysis',
  'implementation', 'planning', 'graphExpert', 'graphWorker', 'graphFast',
] as const;

function pinWrite(draft: Manifest, key: ProcessKey, value: RoleValue): Manifest {
  const row = processRow(draft, key);
  row.pinned = true;
  row.provider = value.core;
  if (value.model) row.model = value.model; else delete row.model;
  if (value.effort) row.effort = value.effort; else delete row.effort;
  return withProcessRow(draft, key, row);
}

/**
 * Edit a role's core/model/effort in the layer that wins: the pin when pinned,
 * otherwise the selected preset. An unpinned edit needs a complete slot
 * (core + model); a half-made value changes nothing yet.
 */
export function writeRole(draft: Manifest, presetName: string | null, capability: string, value: RoleValue): Manifest {
  const key = pinKeyOf(capability);
  if (key !== undefined && pinOf(draft, capability)) {
    return value.core === '' ? draft : pinWrite(draft, key, value);
  }
  if (presetName === null || value.core === '' || value.model === '') return draft;
  return withSlot(draft, presetName, capability, value);
}

/** Pin the role to its current effective value ("same in all presets"). */
export function pinRole(draft: Manifest, presetName: string | null, capability: string): Manifest {
  const key = pinKeyOf(capability);
  const current = effectiveRole(draft, presetName, capability);
  if (key === undefined || current.core === '' || current.source === 'pin') return draft;
  return pinWrite(draft, key, current);
}

/** Drop the pin; the role falls back to the selected preset's slot. */
export function unpinRole(draft: Manifest, capability: string): Manifest {
  const key = pinKeyOf(capability);
  if (key === undefined) return draft;
  const row = processRow(draft, key);
  for (const field of ['pinned', 'provider', 'model', 'effort']) delete row[field];
  return withProcessRow(draft, key, row);
}

/** Clear the value that wins: the pin if pinned, else the preset's slot — the role then falls to Default. */
export function clearRole(draft: Manifest, presetName: string | null, capability: string): Manifest {
  if (pinOf(draft, capability)) return unpinRole(draft, capability);
  return presetName === null ? draft : withSlot(draft, presetName, capability, undefined);
}

/** Copy B's effective value for the role into preset A ("← Copy from B"); unsaved until Save. */
export function copyRoleFrom(draft: Manifest, a: string, b: string, capability: string): Manifest {
  const from = effectiveRole(draft, b, capability);
  if (from.core === '' || from.model === '') return clearRole(draft, a, capability);
  return withSlot(draft, a, capability, from);
}

export { EMPTY as NO_ROLE_VALUE };

/** Assign an agent profile to a process role ('' = Role default). Identity only; never touches pin/slot. */
export function setRoleProfile(draft: Manifest, capability: string, profile: string): Manifest {
  const key = pinKeyOf(capability);
  if (key === undefined) return draft;
  const row = processRow(draft, key);
  if (profile === '') delete row.agent;
  else row.agent = profile;
  return withProcessRow(draft, key, row);
}

/** Switch a process role on/off (`enabled: false` is configured absence). */
export function setRoleEnabled(draft: Manifest, capability: string, enabled: boolean): Manifest {
  const key = pinKeyOf(capability);
  if (key === undefined) return draft;
  const row = processRow(draft, key);
  if (enabled) delete row.enabled;
  else row.enabled = false;
  return withProcessRow(draft, key, row);
}

/** The roles that run through `profile`, in the given capability order. */
export function rolesUsingProfile(draft: Manifest, profile: string, capabilities: readonly string[]): readonly string[] {
  return capabilities.filter((cap) => {
    const key = pinKeyOf(cap);
    return key !== undefined && draft.processes?.[key]?.agent === profile;
  });
}

/** Set the Default row (`agentProvider` / `defaultModel` / `defaultEffort`); '' clears a field. */
export function setDefaultRow(draft: Manifest, value: RoleValue): Manifest {
  return {
    ...draft,
    agentProvider: (value.core || undefined) as Manifest['agentProvider'],
    defaultModel: value.model || undefined,
    defaultEffort: value.effort || undefined,
  };
}
