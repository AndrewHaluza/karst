/**
 * Agent presets: named {provider, model, effort?} bundles (§ agent presets).
 *
 * `resolveAgentDefaults` is the ONE precedence rule for the preset LAYER. It
 * returns the manifest-level defaults a caller feeds into the existing
 * `resolveModelForProvider`/`resolveEffortForProvider` calls, so the per-process
 * and per-ticket explicit fields keep winning exactly as they do today. With no
 * presets configured and no `defaultAgentPreset`, the returned defaults are
 * byte-identical to `manifest.agentProvider` / `manifest.defaultModel` /
 * `manifest.defaultEffort`.
 *
 * A preset is a (core, model) PAIR, so its model and effort apply ONLY when the
 * effective core is the preset's own core. When an operator explicitly picks a
 * different core, the preset's model must NOT travel with it: a catalog-unknown
 * id (a preview/custom model) is accepted by the compatibility guard for ANY
 * provider, so without this gate a preset model would silently launch on the
 * wrong core. Callers pass the explicit core via `explicitProvider`; omitting it
 * asks for the pure settings default (the ticket form's "Inherit" label).
 *
 * vscode-free and catalog-free.
 */

import type { AgentPreset, AgentProvider, Manifest } from '../manifest/types.js';
import { resolveProvider } from './provider.js';

export type { AgentPreset } from '../manifest/types.js';

export interface AgentDefaults {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

export interface ResolveAgentDefaultsOptions {
  /** Preset named by a process role; beats the ticket preset. */
  rolePreset?: string | null;
  /** Preset named by the ticket; beats `manifest.defaultAgentPreset`. */
  ticketPreset?: string | null;
  /**
   * The core explicitly chosen at the same level as the preset reference
   * (process config or ticket). When it differs from the preset's core the
   * preset's model/effort are dropped in favour of the legacy manifest
   * defaults. Absent/blank → the preset (or legacy) core.
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
 * `defaultAgentPreset`. Blank values are "unset" at every layer.
 */
export function effectiveAgentPresetName(
  manifest: Manifest,
  ticketPreset?: string | null,
  rolePreset?: string | null,
): string | undefined {
  return firstNonBlank(rolePreset, ticketPreset, manifest.defaultAgentPreset);
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
 * The manifest-level defaults with the effective preset overlaid on the legacy
 * fields. `provider` is the EFFECTIVE core (explicit, else preset, else legacy);
 * the preset's model/effort are returned only when that core is the preset's.
 */
export function resolveAgentDefaults(
  manifest: Manifest,
  opts: ResolveAgentDefaultsOptions = {},
): AgentDefaults {
  const preset = resolveAgentPreset(
    manifest,
    effectiveAgentPresetName(manifest, opts.ticketPreset, opts.rolePreset),
  );
  const provider = resolveProvider(
    opts.explicitProvider ?? null,
    preset?.provider ?? manifest.agentProvider,
  );
  const presetApplies = preset !== undefined && provider === preset.provider;
  return {
    provider,
    model: presetApplies ? preset.model : manifest.defaultModel,
    effort: presetApplies ? (preset.effort ?? manifest.defaultEffort) : manifest.defaultEffort,
  };
}
