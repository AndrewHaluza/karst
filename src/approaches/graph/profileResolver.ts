/**
 * The ONE live resolver of a graph agent launch profile (AC-04), shared by the
 * driver and by the run identity snapshot (T1258). It lives apart from the
 * driver so `runIdentity.ts` can use it without an import cycle.
 */

import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import { resolvePresetSlot } from '../../agent/agentPresets.js';
import { isKnownProvider } from '../../agent/provider.js';
import { isModelCompatibleWithProvider, resolveEffortForProvider } from '../../agent/models.js';

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Resolve a graph config profile name to provider/model/effort (own keys only). */
export function resolveProfileFor(
  config: GraphApproachConfig,
  profile: string,
): { provider: string; model?: string; effort?: string } | undefined {
  if (!hasOwn(config.profiles, profile)) return undefined;
  const p = config.profiles[profile];
  if (!p) return undefined;
  return { provider: p.provider, model: p.model, effort: p.effort };
}

/**
 * The ONE ticket field a graph launch reads (AC-63). A graph launch never reads
 * the ticket's own core, model or effort: one core cannot fit three roles.
 */
export interface GraphLaunchTicketFields {
  agentPreset: string | null;
}

/** The rung that supplied a graph launch's identity. */
export type GraphProfileSource = 'preset' | 'approach';

export interface ResolvedGraphProfile {
  provider: string;
  model?: string;
  effort?: string;
  source: GraphProfileSource;
}

export const NO_TICKET_FIELDS: GraphLaunchTicketFields = { agentPreset: null };

const GRAPH_CAPABILITY_BY_PROFILE: Readonly<Record<string, 'graphExpert' | 'graphWorker' | 'graphFast'>> = {
  expert: 'graphExpert',
  worker: 'graphWorker',
  fast: 'graphFast',
};

/** True when `model` may launch on `provider` (undefined model → true; unknown core → true, the adapter lookup refuses it). */
function modelFits(provider: string, model: string | undefined): boolean {
  if (model === undefined || !isKnownProvider(provider)) return true;
  return isModelCompatibleWithProvider(provider, model);
}

/**
 * The ONE resolver of a graph agent launch (planner and node), AC-63 order:
 * the preset slot (ticket `agentPreset` → active preset) for
 * `expert`/`worker`/`fast` → the approach profile. It never reads the ticket's
 * own core, model or effort. A slot is an atomic triple: a model the slot's
 * core cannot run drops the WHOLE slot. The catalog gate and the effort gate
 * then run on the result, so nothing unchecked reaches an adapter. `source`
 * names the rung for logs. Own-property lookups only.
 */
export function resolveGraphNodeProfile(
  manifest: Manifest,
  config: GraphApproachConfig,
  profile: string,
  ticket: GraphLaunchTicketFields = NO_TICKET_FIELDS,
  onDebug?: (message: string) => void,
): ResolvedGraphProfile | undefined {
  const capability = hasOwn(GRAPH_CAPABILITY_BY_PROFILE, profile)
    ? GRAPH_CAPABILITY_BY_PROFILE[profile]
    : undefined;
  const slot = capability ? resolvePresetSlot(manifest, capability, ticket.agentPreset) : undefined;
  let base: ResolvedGraphProfile | undefined;
  if (slot && modelFits(slot.provider, slot.model)) {
    base = { provider: slot.provider, model: slot.model, effort: slot.effort, source: 'preset' };
  } else if (slot) {
    onDebug?.(
      `[process] graph node profile "${profile}": preset slot (${slot.provider}/${slot.model}) dropped — model not compatible with ${slot.provider}`,
    );
  }
  if (!base) {
    const approach = resolveProfileFor(config, profile);
    if (approach) {
      base = { ...approach, source: 'approach' };
      if (!modelFits(approach.provider, approach.model)) {
        onDebug?.(
          `[process] graph node profile "${profile}": approach model ${approach.model} dropped — not compatible with ${approach.provider}`,
        );
        base = { provider: approach.provider, source: 'approach' };
      }
    }
  }
  if (!base) return undefined;

  const effort = isKnownProvider(base.provider)
    ? resolveEffortForProvider(base.provider, base.effort, undefined, base.model)
    : base.effort;
  if (base.effort !== undefined && effort === undefined) {
    onDebug?.(`[process] graph node profile "${profile}": effort ${base.effort} dropped — not supported by the model`);
  }
  const resolved: ResolvedGraphProfile = {
    provider: base.provider,
    ...(base.model !== undefined ? { model: base.model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    source: base.source,
  };
  const label = { preset: 'preset slot', approach: 'config' }[resolved.source];
  onDebug?.(
    resolved.source === 'preset'
      ? `[process] graph node profile "${profile}" → preset slot (${resolved.provider})`
      : `[process] graph node profile "${profile}" → ${label} (${resolved.provider}${resolved.model ? `/${resolved.model}` : ''})`,
  );
  return resolved;
}

/** The launch field of a ticket row (AC-63: the ticket `agentPreset` only). */
export function ticketLaunchFields(t: { agentPreset: string | null }): GraphLaunchTicketFields {
  return { agentPreset: t.agentPreset };
}
