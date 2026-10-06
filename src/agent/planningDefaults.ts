/**
 * The planning-session core/model resolution (§ planner gets its own core).
 *
 * A planning session is not a ticket and not a `process_runs` role, but its
 * identity resolves through the SAME ladder a process assignment does, with ONE
 * difference: the FLOOR is the implementation resolution — today's behaviour —
 * rather than the bare manifest defaults.
 *
 * Order, most specific first:
 *   1. the active preset's `planning` slot (rung 2),
 *   2. `processes.planning` (rung 3),
 *   3. the implementation resolution — `resolvePresetDefaults(…, 'implementation')`,
 *      which itself composes the active preset's `implementation` slot over the
 *      manifest `agentProvider`/`defaultModel`.
 *
 * So an existing project that has never configured a planner sees exactly what
 * it saw before: the implementation core/model. A `planning` slot / row changes
 * it for NEW sessions only — a session already stored keeps its own core/model.
 *
 * `processes.planning.enabled: false` treats the planner override as OFF and
 * falls back to the implementation resolution: planning cannot be ABSENT (it
 * always launches), so `enabled` here means "ignore this override", never "do
 * not plan".
 *
 * The implementation floor contributes no EFFORT: a planning launch has never
 * carried one, and adding it would change an existing launch. A planning
 * slot/row effort still applies (the rungs above the floor carry it), and the
 * resolver drops it unless the resolved model advertises it — the same rule
 * every other launch path uses.
 *
 * vscode-free. Reuses `resolveProcessAssignment` by handing it a manifest whose
 * manifest-level defaults ARE the implementation resolution, so the atomic-slot
 * rule ("a model never crosses to another core") and the model compatibility
 * gates are exactly the ones the process resolver already enforces.
 */

import type { Manifest } from '../manifest/types.js';
import { resolveProcessAssignment } from './processAssignment.js';
import { resolvePresetDefaults, type AgentDefaults } from './agentPresets.js';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';

/** The manifest with the `processes.planning` row removed (absent = inherit). */
function withoutPlanning(manifest: Manifest): Manifest {
  if (manifest.processes?.planning === undefined) return manifest;
  const processes = { ...manifest.processes };
  delete processes.planning;
  return { ...manifest, processes };
}

/**
 * The core/model a planning session launches with, given the manifest and the
 * effective preset. Returns the implementation resolution when neither the
 * `planning` slot nor `processes.planning` overrides it.
 */
export function resolvePlanningDefaults(
  manifest: Manifest,
  catalog: ModelCatalog = bundledModelCatalog(),
): AgentDefaults {
  // Rung 4 (the fallback): the implementation resolution, byte-identical to the
  // pre-planner behaviour.
  const base = resolvePresetDefaults(manifest, 'implementation');
  // Hand `resolveProcessAssignment` that floor by making it the manifest-level
  // default: the planning preset slot and `processes.planning` still outrank it.
  const floor: Manifest = {
    ...manifest,
    agentProvider: base.provider,
    defaultModel: base.model,
    defaultEffort: undefined,
  };
  const snapshot = resolveProcessAssignment(floor, 'planning', {}, catalog);
  if (snapshot === null) {
    // `processes.planning.enabled: false` — the override is off, so inherit.
    return {
      provider: base.provider,
      ...(base.model === undefined ? {} : { model: base.model }),
    };
  }
  return {
    provider: snapshot.provider,
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
  };
}

/**
 * The identity the Planner row INHERITS: the planning resolution with the
 * `processes.planning` row itself removed. The Settings row and its Default
 * hints key off this, so the row's own explicit fields are not read back to it
 * as if they were the default.
 */
export function resolvePlanningInherited(
  manifest: Manifest,
  catalog: ModelCatalog = bundledModelCatalog(),
): AgentDefaults {
  return resolvePlanningDefaults(withoutPlanning(manifest), catalog);
}
