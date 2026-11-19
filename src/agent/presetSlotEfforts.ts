/**
 * Save-time checks for `agentPresets` slots (vscode-free, catalog-injected).
 * A bad effort is refused (same rule as a graph profile, `assertProfileEffort`).
 * A model the catalog does not list is only a warning: the catalog can lag a
 * new model, and the launch-time gate drops an unusable slot safely.
 */

import type { Manifest } from '../manifest/types.js';
import { assertProfileEffort, EffortError } from './effort.js';
import type { ModelCatalog } from './modelCatalog.js';

/** Refuse the first preset slot whose effort its model does not advertise. */
export function validatePresetSlotEfforts(manifest: Manifest, catalog: ModelCatalog): void {
  for (const [name, preset] of Object.entries(manifest.agentPresets ?? {})) {
    for (const [capability, slot] of Object.entries(preset.slots)) {
      if (!slot) continue;
      try {
        assertProfileEffort(slot.provider, slot.model, slot.effort, catalog);
      } catch (e) {
        if (!(e instanceof EffortError)) throw e;
        throw new EffortError(e.kind, `agentPresets.${name}.slots.${capability}: ${e.message}`);
      }
    }
  }
}

/** One warning for each preset slot whose model the catalog does not list for its provider. */
export function presetSlotCatalogWarnings(manifest: Manifest, catalog: ModelCatalog): string[] {
  const warnings: string[] = [];
  for (const [name, preset] of Object.entries(manifest.agentPresets ?? {})) {
    for (const [capability, slot] of Object.entries(preset.slots)) {
      if (!slot || catalog[slot.provider].some((m) => m.id === slot.model)) continue;
      warnings.push(
        `agentPresets.${name}.slots.${capability}: model "${slot.model}" is not in the ${slot.provider} catalog — ` +
          'the launch drops this slot when the core cannot run the model',
      );
    }
  }
  return warnings;
}
