/**
 * The Presets tab's draft helpers (NDL-126 §8.3, phase 3 step 3).
 *
 * These are the four rules that are easy to get subtly wrong, lifted out of the
 * component so each one can be tested on its own and so the component stays a
 * rendering of host-computed facts:
 *
 * - **Normalize on the way OUT of a write, never on the way in.** §6's legacy
 *   flat `{provider, model}` preset is ONE slot on every capability. Reading
 *   alone never normalizes — an untouched legacy preset stays byte-for-byte
 *   until the user actually edits it — but every write path normalizes, which
 *   is also what keeps `{provider, model, slots}` (both forms at once, refused
 *   by the host) from ever reaching the file.
 * - **The capability vocabulary comes from the host** (`presetGroups`), in the
 *   order the host lists it, because the "expected one of" fault spells that
 *   same order out (UI-R31).
 * - **A rename is refused while the preset is referenced**, naming every
 *   referrer, and a referenced preset is refused a delete too — the active
 *   selector lives on this tab but `processes.<key>.preset` belongs to the
 *   Agents tab, and a tab-scoped Save writes only its own fields, so clearing
 *   the reference here would never reach the file (the host checks reference
 *   integrity over the whole manifest).
 * - **A reference is checked against BOTH the draft and the file.** A Presets
 *   Save writes the FILE's process rows (its `mergeSection` starts from the
 *   baseline) and a later Agents Save writes the draft's; either keeps the
 *   reference alive, so both are read.
 *
 * Everything else about this tab is host-computed and rendered verbatim: the
 * groups, the row labels and the Inherit previews all arrive in the `state`
 * push and are never derived here.
 */
import type { AgentPreset, Manifest } from '../../../../manifest/types.js';
import type { AgentProvider } from '../../../../manifest/types.js';
import { KNOWN_AGENT_PROVIDERS, AGENT_PROVIDER_LABELS } from '../../../../model/agentProviders.js';
import type { PresetCapabilityGroupView, PresetInheritance } from '../../presetMatrix.js';

/**
 * The host's cap on the preset map, mirrored from
 * `src/manifest/validate/agentPresets.ts`. It is not exported from there, so
 * the bound is restated here in the same commit that reads it — a mirror that
 * refused a file the host accepts would block a file that loads fine.
 */
export const MAX_AGENT_PRESETS = 50;

/** The model-id grammar, mirroring `agentPresets.ts` / `graphConfig.ts`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/;

/** The preset record as the editor works in it: always the `slots:` form. */
export interface SlotsFormPreset {
  label?: string;
  slots: Record<string, PresetSlot>;
}

/** One capability's pinned identity. `provider` + `model` are both required. */
export interface PresetSlot {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

/**
 * A preset as it may arrive from an older file: §6's legacy flat
 * `{provider, model}` record, or the `slots:` form. The manifest's `AgentPreset`
 * types only the `slots:` form, so the legacy keys are read through this
 * widened view — they exist on disk whether or not the type admits them, and the
 * normalizer is exactly the code that has to see them.
 */
type MaybeLegacyPreset = AgentPreset & {
  readonly provider?: AgentProvider;
  readonly model?: string;
  readonly effort?: string;
};

/** The map from a manifest, absent-safe — `draft.agentPresets` may be undefined. */
export function presetMap(manifest: Manifest | undefined): Record<string, AgentPreset> {
  return (manifest?.agentPresets ?? {}) as Record<string, AgentPreset>;
}

/** Preset names in nav order — sorted, matching the vanilla list. */
export function presetNames(manifest: Manifest | undefined): readonly string[] {
  return Object.keys(presetMap(manifest)).sort();
}

/**
 * The one active-preset spelling this tab edits: canonical first, else the
 * legacy `defaultAgentPreset` alias, so a pre-Presets-tab file shows what it
 * actually applies.
 */
export function activePresetName(manifest: Manifest | undefined): string {
  return manifest?.activeAgentPreset || manifest?.defaultAgentPreset || '';
}

/** The preset the matrix is editing, or `null` when none is selected. */
export function currentPreset(
  manifest: Manifest | undefined,
  editing: string | null,
): MaybeLegacyPreset | null {
  if (editing === null) return null;
  const presets = presetMap(manifest);
  return Object.prototype.hasOwnProperty.call(presets, editing)
    ? (presets[editing] as MaybeLegacyPreset)
    : null;
}

/** Every capability id in host order, deduplicated across groups. */
export function presetCapabilityIds(groups: readonly PresetCapabilityGroupView[]): readonly string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const row of group?.rows ?? []) {
      if (row?.capability && ids.indexOf(row.capability) === -1) ids.push(row.capability);
    }
  }
  return ids;
}

/**
 * The preset in `slots:` form. A legacy flat record becomes ONE slot on every
 * capability; an untouched one is only ever passed through this on a write.
 */
export function slotsFormPreset(
  preset: MaybeLegacyPreset | null | undefined,
  capabilityIds: readonly string[],
): SlotsFormPreset {
  if (!preset) return { slots: {} };
  const out: SlotsFormPreset = { slots: {} };
  if (preset.label !== undefined) out.label = preset.label;
  const isLegacy = preset.provider !== undefined || preset.model !== undefined;
  if (!isLegacy) {
    out.slots = { ...((preset.slots ?? {}) as Record<string, PresetSlot>) };
    return out;
  }
  const slot: PresetSlot = { provider: preset.provider as AgentProvider };
  if (preset.model !== undefined) slot.model = preset.model;
  if (preset.effort !== undefined) slot.effort = preset.effort;
  for (const capability of capabilityIds) out.slots[capability] = { ...slot };
  return out;
}

/** How many rows a preset pins — the `n/total overridden` count in the list. */
export function overriddenCount(
  preset: MaybeLegacyPreset | null | undefined,
  capabilityIds: readonly string[],
): number {
  return Object.keys(slotsFormPreset(preset, capabilityIds).slots).length;
}

/**
 * A COMPLETE slot to open an Override row on: the host's inherited identity for
 * this capability, falling back to the project default. A row must never start
 * as `{provider}` with no model — the host refuses that at Save, and a control
 * that switches to Override only to fail on Apply is UI-R25 backwards. `null`
 * means there is nothing valid to seed, so the row stays Inherit rather than
 * opening broken.
 */
export function seedPresetSlot(
  capability: string,
  inheritance: PresetInheritance | undefined,
  manifest: Manifest | undefined,
): PresetSlot | null {
  const inherited = inheritance?.[capability as keyof PresetInheritance];
  const provider = (inherited?.provider || manifest?.agentProvider || '') as AgentProvider | '';
  const model = inherited?.model || manifest?.defaultModel || '';
  if (!provider || !model) return null;
  const effort = inherited?.effort || manifest?.defaultEffort || '';
  return { provider, model, ...(effort ? { effort } : {}) };
}

/** The §5 "Inherited: …" line, joined from the host's preview (UI-R31). */
export function inheritedText(
  capability: string,
  inheritance: PresetInheritance | undefined,
): string {
  const inherited = inheritance?.[capability as keyof PresetInheritance];
  if (!inherited) return 'Inherited: project defaults';
  return `Inherited: ${[inherited.provider, inherited.model, inherited.effort]
    .filter(Boolean)
    .join(' · ')}`;
}

/**
 * Every preset reference a Save could leave in the file, named as the surface
 * an operator can actually change. See the module note on why both the draft
 * and the file are read.
 */
export function presetReferences(
  name: string,
  draft: Manifest | undefined,
  lastSaved: Manifest | undefined,
  roleLabelOf: (key: string) => string | undefined,
): readonly string[] {
  const refs: string[] = [];
  const add = (ref: string): void => {
    if (refs.indexOf(ref) === -1) refs.push(ref);
  };
  if (draft?.activeAgentPreset === name || draft?.defaultAgentPreset === name) {
    add('the active preset selector');
  }
  for (const source of [draft, lastSaved]) {
    for (const [key, cfg] of Object.entries((source?.processes ?? {}) as Record<string, { preset?: string }>)) {
      if (cfg?.preset === name) {
        add(`the "${roleLabelOf(key) ?? key}" process assignment`);
      }
    }
  }
  return refs;
}

/** "A, B and C" — a refusal names every referrer, and this does not read as a run-on. */
export function joinPresetRefs(refs: readonly string[]): string {
  if (refs.length < 2) return refs.join('');
  return `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
}

/**
 * Mirror of `src/manifest/validate/agentPresets.ts` — same bounds, same field
 * paths, same wording, INCLUDING the legacy flat `{provider, model}` preset §6
 * still reads (UI-R34). A mirror that refused a row the host accepts would
 * block a file that loads fine, and one that accepted a row the host refuses
 * would let the fault surface as a banner this form cannot map to a field.
 *
 * Returns the fault, or `null` when the map is writable.
 */
export function validateAgentPresetsDraft(
  presets: unknown,
  known: readonly string[],
): string | null {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const requireString = (v: unknown, where: string): string | null =>
    typeof v !== 'string' || v.trim() === '' || v.length > 512
      ? `${where} must be a non-empty string of at most 512 characters`
      : null;
  const assertKnownKeys = (raw: Record<string, unknown>, keys: readonly string[], where: string): string | null => {
    for (const key of Object.keys(raw)) {
      if (keys.indexOf(key) === -1) return `${where} has unknown key "${key}"`;
    }
    return null;
  };
  const validateSlot = (raw: unknown, where: string): string | null => {
    if (!isObject(raw)) return `${where} must be a mapping`;
    const badKey = assertKnownKeys(raw, ['provider', 'model', 'effort'], where);
    if (badKey) return badKey;
    let fault = requireString(raw.provider, `${where}.provider`);
    if (fault) return fault;
    if (KNOWN_AGENT_PROVIDERS.indexOf(raw.provider as AgentProvider) === -1) {
      return `${where}.provider must be one of: ${KNOWN_AGENT_PROVIDERS.join(', ')}`;
    }
    fault = requireString(raw.model, `${where}.model`);
    if (fault) return fault;
    if (!MODEL_ID.test(String(raw.model))) return `${where}.model is not a valid model id`;
    if (raw.effort !== undefined) {
      fault = requireString(raw.effort, `${where}.effort`);
      if (fault) return fault;
    }
    return null;
  };
  const validateSlotsPreset = (raw: Record<string, unknown>, where: string): string | null => {
    const badKey = assertKnownKeys(raw, ['label', 'slots'], where);
    if (badKey) return badKey;
    if (raw.slots === undefined) {
      return (
        `${where} must define \`slots:\` (a capability → slot mapping) or be a legacy ` +
        '{ provider, model } preset'
      );
    }
    if (!isObject(raw.slots)) return `${where}.slots must be a mapping`;
    for (const capability of Object.keys(raw.slots)) {
      if (known.indexOf(capability) === -1) {
        return `${where}.slots has unknown capability "${capability}" — expected one of: ${known.join(', ')}`;
      }
      const fault = validateSlot(raw.slots[capability], `${where}.slots.${capability}`);
      if (fault) return fault;
    }
    if (raw.label !== undefined && typeof raw.label !== 'string') {
      return `${where}.label must be a string`;
    }
    return null;
  };
  const validatePreset = (raw: unknown, where: string): string | null => {
    if (!isObject(raw)) return `${where} must be a mapping`;
    const isLegacy = raw.provider !== undefined || raw.model !== undefined;
    const isSlotsForm = raw.slots !== undefined || raw.label !== undefined;
    if (isLegacy && isSlotsForm) {
      return (
        `${where} declares both the legacy flat {provider, model} block and the ` +
        'per-capability `slots:`/`label:` form — keep only the `slots:` form'
      );
    }
    // Legacy flat → one slot on EVERY capability (§6). Validated the same way
    // here: the fault wording must not depend on which form the row arrived in.
    if (isLegacy) return validateSlot(raw, where);
    return validateSlotsPreset(raw, where);
  };

  if (presets === undefined) return null;
  if (!isObject(presets)) return 'agentPresets must be a mapping';
  const names = Object.keys(presets);
  if (names.length > MAX_AGENT_PRESETS) {
    return `agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`;
  }
  for (const name of names) {
    if (name.trim() === '') return 'agentPresets has an empty preset name';
    const fault = validatePreset(presets[name], `agentPresets.${name}`);
    if (fault) return fault;
  }
  return null;
}

/** The core options every picker on this tab renders, gating unimplemented cores. */
export function pickerCores(implemented: readonly AgentProvider[]): ReadonlyArray<{
  id: string;
  label: string;
  disabled: boolean;
}> {
  return KNOWN_AGENT_PROVIDERS.map((p) => ({
    id: p,
    label: AGENT_PROVIDER_LABELS[p] || p,
    disabled: implemented.indexOf(p) === -1,
  }));
}

/** A free duplicate name: `x copy`, then `x copy 2`, `x copy 3`, … */
export function duplicateName(name: string, taken: ReadonlySet<string>): string {
  let candidate = `${name} copy`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${name} copy ${n++}`;
  return candidate;
}
