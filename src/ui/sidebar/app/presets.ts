/**
 * The Tickets filter presets. Single-select shortcuts over the host's existing
 * multi-select facet state: a preset is just the facet selection it stands for,
 * so the host protocol is unchanged (`toggle-facet` only).
 */
import type { FacetKey } from '../facets.js';

export type PresetId = 'all' | 'attention' | 'running' | 'done' | 'archived';

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  /** The normalized facet selection this preset stands for. */
  readonly facets: readonly FacetKey[];
}

export const PRESETS: readonly Preset[] = [
  { id: 'all', label: 'All', facets: ['all'] },
  { id: 'attention', label: 'Needs attention', facets: ['input', 'failed'] },
  { id: 'running', label: 'In progress', facets: ['running'] },
  { id: 'done', label: 'Done', facets: ['done'] },
  { id: 'archived', label: 'Archived', facets: ['archived'] },
];

/** The preset a (normalized) facet selection equals, or null for a selection no preset names. */
export function activePreset(facets: readonly FacetKey[]): Preset | null {
  const set = new Set(facets);
  return PRESETS.find((p) => p.facets.length === set.size && p.facets.every((f) => set.has(f))) ?? null;
}

/**
 * The `toggle-facet` keys to post, in order, to reach a preset from ANY current
 * selection: `all` resets the host's union first, then each facet toggles on.
 */
export function presetToggles(preset: Preset): FacetKey[] {
  return preset.id === 'all' ? ['all'] : ['all', ...preset.facets];
}
