/**
 * Save-time checks for `agentPresets` slots (vscode-free, catalog-injected).
 * A bad effort is refused (same rule as a graph profile, `assertProfileEffort`).
 * A model the catalog does not list is only a warning: the catalog can lag a
 * new model, and the launch-time gate drops an unusable slot safely.
 */

import type { Manifest } from '../manifest/types.js';
import { assertProfileEffort, EffortError } from './effort.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentProviders.js';
import { presetModelUnlistedText, type UnlistedPresetModel } from '../model/notifyText.js';
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
        // A model the catalog does not list is a warning (`presetSlotCatalogWarnings`), never a refusal.
        if (e.kind === 'not-cataloged') continue;
        throw new EffortError(e.kind, `agentPresets.${name}.slots.${capability}: ${e.message}`);
      }
    }
  }
}

/**
 * One warning for each preset with a slot that the Save added, or whose provider or model the
 * Save changed (compared with `previous`), and whose model the catalog does not list.
 * Without `previous`, every slot counts as new.
 */
export function presetSlotCatalogWarnings(manifest: Manifest, catalog: ModelCatalog, previous?: Manifest): string[] {
  const warnings: string[] = [];
  for (const [name, preset] of Object.entries(manifest.agentPresets ?? {})) {
    const before = previous?.agentPresets?.[name]?.slots ?? {};
    const models: UnlistedPresetModel[] = [];
    let roleCount = 0;
    for (const [capability, slot] of Object.entries(preset.slots)) {
      if (!slot || catalog[slot.provider].some((m) => m.id === slot.model)) continue;
      const old = (before as Record<string, { provider: string; model: string } | undefined>)[capability];
      if (old && old.provider === slot.provider && old.model === slot.model) continue;
      roleCount += 1;
      const providerLabel = AGENT_PROVIDER_LABELS[slot.provider] ?? slot.provider;
      if (!models.some((m) => m.providerLabel === providerLabel && m.model === slot.model)) {
        models.push({ providerLabel, model: slot.model });
      }
    }
    if (roleCount > 0) warnings.push(presetModelUnlistedText(name, models, roleCount));
  }
  return warnings;
}
