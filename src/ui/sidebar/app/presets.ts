/**
 * The Tickets filter presets. Single-select shortcuts over the host's existing
 * multi-select facet state: a preset is just the facet selection it stands for,
 * so the host protocol is unchanged (`toggle-facet` only). A state preset's
 * label is the shared `GLYPH_WORD` (SB-13), so the menu and the glyph name one
 * state; the attention preset names its two parts.
 */
import type { FacetKey } from '../facets.js';
import { GLYPH_WORD } from '../../../model/glyph.js';

export type PresetId = 'all' | 'attention' | 'running' | 'done' | 'archived';

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  /** The normalized facet selection this preset stands for. */
  readonly facets: readonly FacetKey[];
}

/** The attention preset names both parts it filters: needs-you (amber) + failed (red). */
export const ATTENTION_PRESET_LABEL = `${GLYPH_WORD.amber} or ${GLYPH_WORD.red.toLowerCase()}`;

export const PRESETS: readonly Preset[] = [
  { id: 'all', label: 'All', facets: ['all'] },
  { id: 'attention', label: ATTENTION_PRESET_LABEL, facets: ['input', 'failed'] },
  { id: 'running', label: GLYPH_WORD.blue, facets: ['running'] },
  { id: 'done', label: GLYPH_WORD.green, facets: ['done'] },
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
