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

/** The ticket fields a graph launch reads (AC-04 ticket rungs). */
export interface GraphLaunchTicketFields {
  agentPreset: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
}

/** The rung that supplied a graph launch's identity. */
export type GraphProfileSource = 'ticket' | 'preset' | 'approach';

export interface ResolvedGraphProfile {
  provider: string;
  model?: string;
  effort?: string;
  source: GraphProfileSource;
}

export const NO_TICKET_FIELDS: GraphLaunchTicketFields = { agentPreset: null, provider: null, model: null, effort: null };

const GRAPH_CAPABILITY_BY_PROFILE: Readonly<Record<string, 'graphExpert' | 'graphWorker' | 'graphFast'>> = {
  expert: 'graphExpert',
  worker: 'graphWorker',
  fast: 'graphFast',
};

const nonBlank = (v: string | null | undefined): string | undefined =>
  v !== null && v !== undefined && v.trim() !== '' ? v : undefined;

/** True when `model` may launch on `provider` (undefined model → true; unknown core → true, the adapter lookup refuses it). */
function modelFits(provider: string, model: string | undefined): boolean {
  if (model === undefined || !isKnownProvider(provider)) return true;
  return isModelCompatibleWithProvider(provider, model);
}

/**
 * The ONE resolver of a graph agent launch (planner and node), AC-04 order:
 * the ticket's own core/model/effort → the preset slot (ticket `agentPreset` →
 * active preset) for `expert`/`worker`/`fast` → the approach profile. A slot
 * is an atomic triple: a model the slot's core cannot run drops the WHOLE slot,
 * and a ticket core that differs from the slot's drops it too. The catalog gate
 * and the effort gate then run on the result, so nothing unchecked reaches an
 * adapter. `source` names the rung for logs. Own-property lookups only.
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

  const ticketProvider = nonBlank(ticket.provider);
  if (ticketProvider && base?.provider !== ticketProvider) {
    base = { provider: ticketProvider, source: 'ticket' };
  } else if (ticketProvider && base) {
    base = { ...base, source: 'ticket' };
  }
  if (!base) return undefined;
  const ticketModel = nonBlank(ticket.model);
  const ticketEffort = nonBlank(ticket.effort);
  if (ticketModel && modelFits(base.provider, ticketModel)) {
    base = { ...base, model: ticketModel, source: 'ticket' };
  }
  if (ticketEffort) base = { ...base, effort: ticketEffort, source: 'ticket' };

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
  const label = { ticket: 'ticket', preset: 'preset slot', approach: 'config' }[resolved.source];
  onDebug?.(
    resolved.source === 'preset'
      ? `[process] graph node profile "${profile}" → preset slot (${resolved.provider})`
      : `[process] graph node profile "${profile}" → ${label} (${resolved.provider}${resolved.model ? `/${resolved.model}` : ''})`,
  );
  return resolved;
}

/** The launch fields of a ticket row (AC-04 ticket rungs). */
export function ticketLaunchFields(t: {
  agentPreset: string | null;
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
}): GraphLaunchTicketFields {
  return { agentPreset: t.agentPreset, provider: t.agentProvider, model: t.model, effort: t.effort };
}
