/**
 * Agent presets: named SPARSE capability → slot matrices (§3).
 *
 * `resolvePresetSlot` is the ONE function that reads `manifest.agentPresets`.
 * It answers a single question — "does the effective preset override this
 * capability?" — with a whole `PresetSlot` (core + model + effort) or
 * `undefined` for Inherit. Every other preset-aware site composes that answer
 * over the rungs beneath it; nothing outside this file touches the preset map.
 *
 * Effective preset name: the calling scope's own name (a ticket's
 * `agentPreset`, or a process role's deprecated `processes.<key>.preset`, §6)
 * → `activeAgentPreset` → the `defaultAgentPreset` alias. A blank or dangling
 * name degrades to Inherit, never to a guess.
 *
 * A slot is an ATOMIC triple: it applies only when the resolved core is the
 * slot's own core, so a model never crosses to another core — the guarantee
 * the old `resolveAgentDefaults` carried, now decided by each caller from the
 * slot it is handed (§4 rung 2 "the whole slot applies atomically").
 *
 * vscode-free and catalog-free.
 */

import type {
  AgentPreset,
  AgentProvider,
  Manifest,
  PresetCapability,
  PresetSlot,
} from '../manifest/types.js';
import { PROCESS_KEYS, type ProcessKey } from '../manifest/validate/processAssignments.js';
import { resolveProvider } from './provider.js';

export type { AgentPreset, PresetSlot } from '../manifest/types.js';

/**
 * Which rung of the precedence ladder supplied the effective core:
 * ticket field → pin (`processes.<role>` with `pinned: true`) → active preset
 * slot → manifest default row → the 'claude' floor.
 */
export type AgentSource = 'ticket' | 'pin' | 'preset' | 'default' | 'fallback';

/** The manifest-level defaults a caller feeds into the existing launch gates. */
export interface AgentDefaults {
  provider: AgentProvider;
  model?: string;
  effort?: string;
  source: AgentSource;
}

/** A role's PIN: core (+ model/effort) that beats every preset ("same in all presets"). */
export interface RolePin {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

/**
 * The pin for a capability, or undefined. Only a `processes.<key>` row with
 * `pinned: true` and a core is a pin; an unpinned row carries no identity.
 */
export function resolveRolePin(manifest: Manifest, capability: PresetCapability): RolePin | undefined {
  if (!(PROCESS_KEYS as readonly string[]).includes(capability)) return undefined;
  const row = manifest.processes?.[capability as ProcessKey];
  if (row?.pinned !== true || row.provider === undefined) return undefined;
  return {
    provider: row.provider,
    ...(row.model === undefined ? {} : { model: row.model }),
    ...(row.effort === undefined ? {} : { effort: row.effort }),
  };
}

export interface ResolvePresetDefaultsOptions {
  /** Preset named by a process role; beats the ticket preset (§6). */
  rolePreset?: string | null;
  /** Preset named by the ticket; beats `manifest.activeAgentPreset`. */
  ticketPreset?: string | null;
  /**
   * The core explicitly chosen at the same level as the preset reference.
   * When it differs from the slot's core the slot's model/effort are dropped
   * in favour of the legacy manifest defaults. Absent/blank → the slot (or
   * legacy) core.
   */
  explicitProvider?: AgentProvider | null;
}

function firstNonBlank(...vals: (string | null | undefined)[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * The preset name that applies, most specific first: a process role's own
 * `processes.<key>.preset`, then the ticket's `agentPreset`, then the manifest
 * `activeAgentPreset`, then the deprecated `defaultAgentPreset` alias (§6:
 * both spellings name one active preset, so a legacy-keyed file selects
 * exactly the same preset a new-keyed one would). Blank is "unset" at every
 * layer.
 */
export function effectiveAgentPresetName(
  manifest: Manifest,
  ticketPreset?: string | null,
  rolePreset?: string | null,
): string | undefined {
  return firstNonBlank(
    rolePreset,
    ticketPreset,
    manifest.activeAgentPreset,
    manifest.defaultAgentPreset,
  );
}

/**
 * The named preset, or undefined for an unset/dangling name. Never throws.
 * Own-property only: `presets[key]` walks the prototype chain, so a name like
 * "toString" or "__proto__" must not resolve to an inherited member.
 */
export function resolveAgentPreset(
  manifest: Manifest,
  name?: string | null,
): AgentPreset | undefined {
  const key = firstNonBlank(name);
  const presets = manifest.agentPresets;
  if (key === undefined || presets === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(presets, key)) return undefined;
  return presets[key];
}

/**
 * THE preset resolver (§4): the effective preset's slot for ONE capability, or
 * `undefined` = Inherit. `ticketPresetName` is the preset name this calling
 * scope supplies (a ticket's `agentPreset`; a process role passes its
 * deprecated `processes.<key>.preset` first, §6); with none, the manifest's
 * active preset applies. An absent capability on a sparse preset is Inherit —
 * it falls through to the process assignment / per-agent config / manifest
 * defaults, never to a guessed value.
 */
export function resolvePresetSlot(
  manifest: Manifest,
  capability: PresetCapability,
  ticketPresetName?: string | null,
): PresetSlot | undefined {
  const preset = resolveAgentPreset(
    manifest,
    effectiveAgentPresetName(manifest, ticketPresetName),
  );
  // Sparse: a preset declares a slot only for the capabilities it overrides.
  return preset?.slots[capability];
}

/**
 * The manifest-level defaults with the effective preset's slot for
 * `capability` overlaid on the legacy fields — the rung-2-over-rung-4
 * composition every launch path that has no process config of its own uses.
 * `provider` is the EFFECTIVE core (explicit, else slot, else legacy); the
 * slot's model/effort are returned only when that core is the slot's.
 *
 * This is a composer, not a second resolver: it never reads `agentPresets`,
 * it only lays the slot `resolvePresetSlot` returned over the manifest.
 */
export function resolvePresetDefaults(
  manifest: Manifest,
  capability: PresetCapability,
  opts: ResolvePresetDefaultsOptions = {},
): AgentDefaults {
  const explicit = firstNonBlank(opts.explicitProvider) as AgentProvider | undefined;
  const pin = resolveRolePin(manifest, capability);
  // Pin beats the preset slot; a differing explicit core drops the whole pin.
  const activePin = pin !== undefined && (explicit === undefined || explicit === pin.provider) ? pin : undefined;
  const slot =
    activePin !== undefined
      ? undefined
      : resolvePresetSlot(
          manifest,
          capability,
          effectiveAgentPresetName(manifest, opts.ticketPreset, opts.rolePreset),
        );
  const provider = resolveProvider(
    opts.explicitProvider ?? null,
    activePin?.provider ?? slot?.provider ?? manifest.agentProvider,
  );
  const layer = activePin ?? (slot !== undefined && provider === slot.provider ? slot : undefined);
  const source: AgentSource =
    explicit !== undefined
      ? 'ticket'
      : activePin !== undefined
        ? 'pin'
        : layer !== undefined
          ? 'preset'
          : manifest.agentProvider !== undefined
            ? 'default'
            : 'fallback';
  return {
    provider,
    model: layer !== undefined ? layer.model : manifest.defaultModel,
    effort: layer !== undefined ? (layer.effort ?? manifest.defaultEffort) : manifest.defaultEffort,
    source,
  };
}
