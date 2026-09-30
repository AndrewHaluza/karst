/**
 * The Presets tab's MATRIX shape and its host-computed Inherit preview (§5).
 *
 * Two kinds of fact live here, both host-side so the webview renders them
 * verbatim (UI-R31):
 *
 *  - `PRESET_CAPABILITY_GROUPS` / `PRESET_CAPABILITY_LABELS` — which capability
 *    a row is, and which of the three groups it sits under. The groups are the
 *    §5 Quality / Ticket / Graph-role split; the labels are the names the
 *    process rows and the ticket form already use, so one capability reads the
 *    same everywhere.
 *
 *  - `buildPresetInheritanceViews` — for EVERY capability, the identity the
 *    launch path resolves when NO preset overrides it: `processes.<key>` for
 *    the six inside roles, the approach's graph profile for expert/worker/fast,
 *    the manifest defaults for implementation. That is exactly what an
 *    `Inherit (default)` row means, so the editor can grey it out beside the
 *    row instead of asking the operator to remember what they configured
 *    elsewhere.
 *
 * The preview is computed against a manifest with ALL preset influence removed
 * (the preset map, both active-preset spellings and every deprecated
 * `processes.<key>.preset`), because "Inherit" is defined as the value beneath
 * the preset rung — the same resolver the launch path uses, one rung down.
 * A disabled process is probed as enabled: the preview answers "which core and
 * model would this run on", not "is it running", so an off role still shows the
 * identity it would take if switched on.
 */
import type {
  AgentProvider,
  Manifest,
  PresetCapability,
} from '../../manifest/types.js';
import { PRESET_CAPABILITIES } from '../../manifest/types.js';
import {
  PROCESS_KEYS,
  PROCESS_ROLE_BY_KEY,
  type ProcessKey,
} from '../../manifest/validate/processAssignments.js';
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { resolvePresetDefaults } from '../../agent/agentPresets.js';
import { bundledModelCatalog, type ModelCatalog } from '../../agent/modelCatalog.js';

/** One of the three §5 row groups. */
export interface PresetCapabilityGroup {
  id: 'quality' | 'ticket' | 'graph';
  label: string;
  capabilities: readonly PresetCapability[];
}

/** Quality / Ticket / Graph roles — the §5 grouping, in render order. */
export const PRESET_CAPABILITY_GROUPS: readonly PresetCapabilityGroup[] = [
  { id: 'quality', label: 'Quality', capabilities: ['uatTester', 'uatFix', 'review', 'reviewFix'] },
  {
    id: 'ticket',
    label: 'Ticket',
    capabilities: ['prDescription', 'ticketAnalysis', 'implementation'],
  },
  { id: 'graph', label: 'Graph roles', capabilities: ['graphExpert', 'graphWorker', 'graphFast'] },
];

/**
 * Row names. The six inside-process rows reuse the handoff §7 role labels the
 * Agents tab shows; `implementation` is the ticket-form wording; the graph rows
 * are the profile ids' user-facing names.
 */
export const PRESET_CAPABILITY_LABELS: Record<PresetCapability, string> = {
  uatTester: 'UAT Tester',
  uatFix: 'UAT Fix',
  review: 'Review',
  reviewFix: 'Review Fix',
  prDescription: 'PR description',
  ticketAnalysis: 'Ticket analysis',
  implementation: 'Ticket implementation',
  graphExpert: 'Expert',
  graphWorker: 'Worker',
  graphFast: 'Fast',
};

/**
 * One §5 row as the webview receives it: the id AND the label together (UI-R31),
 * so the page renders the vocabulary verbatim and never keeps a second copy of
 * either — a new capability would otherwise arrive in the group list and never
 * in the labels, or the reverse.
 */
export interface PresetCapabilityRowView {
  capability: PresetCapability;
  label: string;
}

/** A §5 group with its rows, in render order — the whole matrix shape. */
export interface PresetCapabilityGroupView {
  id: PresetCapabilityGroup['id'];
  label: string;
  rows: PresetCapabilityRowView[];
}

/**
 * The matrix shape, flattened for transport. Derived from the two constants
 * above rather than written out again: the grouping and the names are already
 * decided, this only pairs them.
 */
export function buildPresetCapabilityGroups(): PresetCapabilityGroupView[] {
  return PRESET_CAPABILITY_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    rows: group.capabilities.map((capability) => ({
      capability,
      label: PRESET_CAPABILITY_LABELS[capability],
    })),
  }));
}

/** The identity an Inherit row resolves to; `effort` is carried only when the model advertises it. */
export interface PresetInheritedIdentity {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

/** Capability → identity beneath the preset rung, keyed by every §3 row. */
export type PresetInheritance = Record<PresetCapability, PresetInheritedIdentity>;

/** Capabilities whose identity the `processes:` block owns. */
const PROCESS_CAPABILITIES: ReadonlySet<string> = new Set<string>(PROCESS_KEYS);

/** Graph profile ids, in PRESET_CAPABILITIES order. */
const GRAPH_PROFILE_OF: Partial<Record<PresetCapability, string>> = {
  graphExpert: 'expert',
  graphWorker: 'worker',
  graphFast: 'fast',
};

/**
 * The manifest with EVERY preset influence stripped, so the resolvers below
 * answer "what does this capability fall back to" rather than "what does the
 * active preset say". Own-property deletion: an absent key is the same
 * Inherit case the resolver already treats as unset.
 */
function withoutPresetInfluence(manifest: Manifest): Manifest {
  const stripped: Record<string, unknown> = { ...(manifest as unknown as Record<string, unknown>) };
  delete stripped.agentPresets;
  delete stripped.activeAgentPreset;
  delete stripped.defaultAgentPreset;
  const processes = stripped.processes as Record<string, Record<string, unknown>> | undefined;
  if (processes !== undefined) {
    const cleaned: Record<string, Record<string, unknown>> = {};
    for (const [key, cfg] of Object.entries(processes)) {
      if (cfg === undefined) continue;
      const { preset: _deprecated, ...rest } = cfg;
      cleaned[key] = rest;
    }
    stripped.processes = cleaned;
  }
  return stripped as unknown as Manifest;
}

/** The process block for `key`, probed as enabled (see the module header). */
function probed(base: Manifest, key: ProcessKey): Manifest {
  const cfg = base.processes?.[key];
  if (cfg?.enabled !== false) return base;
  return {
    ...base,
    processes: { ...base.processes, [key]: { ...cfg, enabled: true } },
  };
}

/**
 * The graph profile `role` resolves to on the approach that declares it, or
 * undefined when no approach in the manifest names that profile id.
 *
 * The state manifest is post-`withBuiltInApproaches`, so the packaged graph
 * approach is already in the list — a project that never touched `graph:`
 * still previews its built-in expert/worker/fast profiles.
 */
function graphProfileFor(
  manifest: Manifest,
  role: string,
): { provider: AgentProvider; model?: string; effort?: string } | undefined {
  for (const approach of manifest.approaches ?? []) {
    const profile = approach.graph?.profiles?.[role];
    if (profile !== undefined) {
      return {
        provider: profile.provider,
        ...(profile.model === undefined ? {} : { model: profile.model }),
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      };
    }
  }
  return undefined;
}

/**
 * For each of the §3 capabilities, the identity that capability inherits when
 * no preset slot covers it. Keys are complete: every `PRESET_CAPABILITIES`
 * entry has an entry, so a row never has to guess at a missing preview.
 */
export function buildPresetInheritanceViews(
  manifest: Manifest,
  catalog: ModelCatalog = bundledModelCatalog(),
): PresetInheritance {
  const base = withoutPresetInfluence(manifest);
  const views = {} as PresetInheritance;

  for (const capability of PRESET_CAPABILITIES) {
    if (PROCESS_CAPABILITIES.has(capability)) {
      const processKey = capability as ProcessKey;
      const snapshot = resolveProcessAssignment(
        probed(base, processKey),
        PROCESS_ROLE_BY_KEY[processKey],
        {},
        catalog,
      );
      if (snapshot !== null) {
        views[capability] = {
          provider: snapshot.provider,
          ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
          ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
        };
        continue;
      }
    }

    const profileRole = GRAPH_PROFILE_OF[capability];
    const fromProfile = profileRole === undefined ? undefined : graphProfileFor(base, profileRole);
    if (fromProfile !== undefined) {
      views[capability] = fromProfile;
      continue;
    }

    // implementation, and any graph profile no approach declares: the manifest
    // defaults — the same rung `resolvePresetDefaults` composes a slot over.
    const defaults = resolvePresetDefaults(base, capability);
    views[capability] = {
      provider: defaults.provider,
      ...(defaults.model === undefined ? {} : { model: defaults.model }),
      ...(defaults.effort === undefined ? {} : { effort: defaults.effort }),
    };
  }

  return views;
}
