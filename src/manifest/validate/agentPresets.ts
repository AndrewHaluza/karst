/**
 * Validate the top-level `agentPresets:` map (§3, a sparse capability → slot
 * matrix), the active-preset name (`activeAgentPreset:` and its deprecated
 * `defaultAgentPreset:` alias, §6), and the reference integrity of every
 * manifest-level preset reference.
 *
 * Mirrors `validate/processAssignments.ts`: every absent field is defaulted,
 * every unknown key is refused with the field named, and reference integrity is
 * checked for values this pure loader can see. The ticket-level preset is store
 * data and is NOT checked here — a dangling ticket reference degrades to "no
 * preset" at resolution, and the ticket form surfaces it.
 *
 * The legacy flat `{provider, model, effort?}` preset and the deprecated
 * `processes.<key>.preset` key are both read here rather than migrated away:
 * §6 keeps every existing file working byte-for-byte, and only says so.
 */

import { ManifestError } from '../error.js';
import {
  PRESET_CAPABILITIES,
  type AgentPreset,
  type AgentProvider,
  type PresetCapability,
  type PresetSlot,
  type ProcessAssignmentsConfig,
} from '../types.js';

const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];

/** Model id bound — mirrors the graph profile model grammar. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/;

/** A typo must not turn one method into an unbounded config block. */
const MAX_AGENT_PRESETS = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 512) {
    throw new ManifestError(`${where} must be a non-empty string of at most 512 characters`);
  }
  return v;
}

function assertKnownKeys(raw: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!(known as readonly string[]).includes(key)) {
      throw new ManifestError(`${where} has unknown key "${key}"`);
    }
  }
}

/**
 * One slot: a `{provider, model, effort?}` triple. The same shape and messages
 * as the old flat preset, because a slot IS that flat bundle — the only thing
 * that changed is which capability it sits on.
 */
function validateSlot(raw: unknown, where: string): PresetSlot {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['provider', 'model', 'effort'], where);

  const provider = requireString(raw.provider, `${where}.provider`);
  if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ManifestError(`${where}.provider must be one of: ${AGENT_PROVIDERS.join(', ')}`);
  }
  const model = requireString(raw.model, `${where}.model`);
  if (!MODEL_ID.test(model)) {
    throw new ManifestError(`${where}.model is not a valid model id`);
  }
  const slot: PresetSlot = { provider: provider as AgentProvider, model };
  if (raw.effort !== undefined) slot.effort = requireString(raw.effort, `${where}.effort`);
  return slot;
}

/**
 * Legacy flat preset → the same slot on EVERY capability (§6). This is what
 * preserves today's behaviour exactly: a flat preset applied globally, so a
 * normalized one must override every row and inherit nothing.
 */
function normalizeLegacyPreset(raw: Record<string, unknown>, where: string): AgentPreset {
  const slot = validateSlot(raw, where);
  const slots: AgentPreset['slots'] = {};
  for (const capability of PRESET_CAPABILITIES) {
    slots[capability] = { ...slot };
  }
  return { slots };
}

/** Current per-capability shape: `{ label?, slots: { <capability>: slot } }`. */
function validateSlotsPreset(raw: Record<string, unknown>, where: string): AgentPreset {
  assertKnownKeys(raw, ['label', 'slots'], where);

  const slotsRaw = raw.slots;
  if (slotsRaw === undefined) {
    throw new ManifestError(
      `${where} must define \`slots:\` (a capability → slot mapping) or be a legacy ` +
        '{ provider, model } preset',
    );
  }
  if (!isObject(slotsRaw)) throw new ManifestError(`${where}.slots must be a mapping`);

  const slots: AgentPreset['slots'] = {};
  for (const [capability, value] of Object.entries(slotsRaw)) {
    if (!(PRESET_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new ManifestError(
        `${where}.slots has unknown capability "${capability}" — expected one of: ` +
          PRESET_CAPABILITIES.join(', '),
      );
    }
    slots[capability as PresetCapability] = validateSlot(value, `${where}.slots.${capability}`);
  }

  const preset: AgentPreset = { slots };
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') throw new ManifestError(`${where}.label must be a string`);
    if (raw.label.trim() !== '') preset.label = raw.label;
  }
  return preset;
}

function validatePreset(raw: unknown, where: string): AgentPreset {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);

  const isLegacy = raw.provider !== undefined || raw.model !== undefined;
  const isSlotsForm = raw.slots !== undefined || raw.label !== undefined;

  if (isLegacy && isSlotsForm) {
    throw new ManifestError(
      `${where} declares both the legacy flat {provider, model} block and the ` +
        'per-capability `slots:`/`label:` form — keep only the `slots:` form',
    );
  }
  if (isLegacy) return normalizeLegacyPreset(raw, where);
  return validateSlotsPreset(raw, where);
}

export function validateAgentPresets(raw: unknown): Record<string, AgentPreset> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('agentPresets must be a mapping');
  const keys = Object.keys(raw);
  if (keys.length > MAX_AGENT_PRESETS) {
    throw new ManifestError(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
  }
  const presets: Record<string, AgentPreset> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim() === '') throw new ManifestError('agentPresets has an empty preset name');
    presets[name] = validatePreset(value, `agentPresets.${name}`);
  }
  return presets;
}

/** A preset-name field: blank normalizes to undefined (no active preset). */
function validatePresetName(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ManifestError(`${field} must be a string`);
  return raw.trim() === '' ? undefined : raw;
}

/** Canonical active-preset name (`activeAgentPreset:`). */
export function validateActiveAgentPreset(raw: unknown): string | undefined {
  return validatePresetName(raw, 'activeAgentPreset');
}

/** Deprecated alias of `activeAgentPreset` (`defaultAgentPreset:`). */
export function validateDefaultAgentPreset(raw: unknown): string | undefined {
  return validatePresetName(raw, 'defaultAgentPreset');
}

/**
 * §6: the two keys name the SAME single active preset, so a file carrying both
 * is ambiguous and is refused rather than letting one silently win. Checked on
 * the NORMALIZED values, so a blank key or a cleared (undefined) one never
 * trips it.
 */
export function assertExclusiveActivePreset(
  activeAgentPreset: string | undefined,
  defaultAgentPreset: string | undefined,
): void {
  if (activeAgentPreset !== undefined && defaultAgentPreset !== undefined) {
    throw new ManifestError(
      'declares both `activeAgentPreset:` and the legacy `defaultAgentPreset:` key — ' +
        'they name the same single active preset, so karst will not guess which one is ' +
        'authoritative; delete `defaultAgentPreset:`.',
    );
  }
}

/**
 * Own-property only: `presets[key]` walks the prototype chain, so a name like
 * "toString" or "__proto__" must not satisfy reference integrity.
 */
function assertNamed(
  presets: Record<string, AgentPreset> | undefined,
  name: string,
  field: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(presets ?? {}, name)) {
    throw new ManifestError(
      `${field} "${name}" names no agent preset — ` +
        'define it under agentPresets or remove the field',
    );
  }
}

/**
 * Every manifest-level preset reference must resolve. A dangling
 * `activeAgentPreset`, `defaultAgentPreset` or `processes.<key>.preset` would
 * otherwise silently do nothing, which reads as "the preset was ignored".
 */
export function assertActiveAgentPresetReference(
  presets: Record<string, AgentPreset> | undefined,
  activeAgentPreset: string | undefined,
): void {
  if (activeAgentPreset !== undefined) assertNamed(presets, activeAgentPreset, 'activeAgentPreset');
}

export function assertAgentPresetReferences(
  presets: Record<string, AgentPreset> | undefined,
  defaultAgentPreset: string | undefined,
  processes: ProcessAssignmentsConfig | undefined,
): void {
  if (defaultAgentPreset !== undefined) assertNamed(presets, defaultAgentPreset, 'defaultAgentPreset');
  for (const [key, cfg] of Object.entries(processes ?? {})) {
    if (cfg.preset !== undefined) assertNamed(presets, cfg.preset, `processes.${key}.preset`);
  }
}

/**
 * §6: `processes.<key>.preset` is deprecated. Still read for one release, but
 * every use says so — the fix names the capability row the user must set
 * instead, which is the same key (`PROCESS_KEYS` ⊂ `PRESET_CAPABILITIES`).
 */
export function deprecatedPresetKeyWarnings(
  processes: ProcessAssignmentsConfig | undefined,
): string[] {
  const warnings: string[] = [];
  for (const [key, cfg] of Object.entries(processes ?? {})) {
    if (cfg.preset === undefined) continue;
    warnings.push(
      `\`processes.${key}.preset\` is deprecated and is removed in the next release. ` +
        `It is still honoured (it applies preset "${cfg.preset}" to this role), but a preset ` +
        `now overrides capabilities directly: set the \`${key}\` slot under \`agentPresets\` ` +
        'and select the preset under `activeAgentPreset`, then delete this key.',
    );
  }
  return warnings;
}
