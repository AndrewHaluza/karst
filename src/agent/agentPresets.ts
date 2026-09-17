/**
 * Agent presets: named {provider, model, effort?} bundles (§ agent presets).
 *
 * These functions are the ONE precedence rule for the preset LAYER. They return
 * the manifest-level defaults a caller feeds into the existing
 * `resolveProvider`/`resolveModelForProvider`/`resolveEffortForProvider` calls,
 * so the per-process and per-ticket explicit fields keep winning exactly as
 * they do today. With no presets configured and no `defaultAgentPreset`, the
 * returned defaults are byte-identical to `manifest.agentProvider` /
 * `manifest.defaultModel` / `manifest.defaultEffort`.
 *
 * vscode-free and catalog-free: compatibility (a preset model that the resolved
 * provider cannot run) is judged by the existing provider-compatibility check
 * at the call site, not here.
 */

import type { AgentPreset, AgentProvider, Manifest } from '../manifest/types.js';

export type { AgentPreset } from '../manifest/types.js';

export interface AgentDefaults {
  provider: AgentProvider;
  model?: string;
  effort?: string;
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

/** The named preset, or undefined for an unset/dangling name. Never throws. */
export function resolveAgentPreset(
  manifest: Manifest,
  name?: string | null,
): AgentPreset | undefined {
  const key = firstNonBlank(name);
  if (key === undefined) return undefined;
  return manifest.agentPresets?.[key];
}

/** The manifest-level defaults, with the effective preset overlaid on the legacy fields. */
export function resolveAgentDefaults(
  manifest: Manifest,
  ticketPreset?: string | null,
  rolePreset?: string | null,
): AgentDefaults {
  const preset = resolveAgentPreset(
    manifest,
    effectiveAgentPresetName(manifest, ticketPreset, rolePreset),
  );
  return {
    provider: preset?.provider ?? manifest.agentProvider ?? 'claude',
    model: preset?.model ?? manifest.defaultModel,
    effort: preset?.effort ?? manifest.defaultEffort,
  };
}
