/**
 * Preset create / duplicate / rename / delete / activate over the draft, for the
 * Agents page's preset toolbar. Pure: each op returns a new draft or a refusal
 * message, never both, and never mutates its input.
 *
 * The rules are the Presets tab's, unchanged: a name is a key every reference
 * stores (so it is never trimmed), a rename or delete is refused while the
 * preset is referenced, the map is bounded, and every write goes through the
 * `slots:` form so a legacy flat record is never written back in a shape that
 * carries both forms.
 */
import { PRESET_CAPABILITIES, type AgentPreset, type Manifest } from '../../../../manifest/types.js';
import {
  MAX_AGENT_PRESETS,
  duplicateName,
  joinPresetRefs,
  presetMap,
  presetReferences,
  slotsFormPreset,
  validateAgentPresetsDraft,
} from './presetDraft.js';

export type PresetOpResult =
  | { readonly ok: true; readonly draft: Manifest; readonly name: string }
  | { readonly ok: false; readonly error: string };

const CAPABILITIES: readonly string[] = PRESET_CAPABILITIES;

const refuse = (error: string): PresetOpResult => ({ ok: false, error });

/** Replace the map; an empty map DELETES the key (absent IS "no presets"). */
function withPresets(draft: Manifest, next: Record<string, AgentPreset>): Manifest {
  const rest = { ...draft };
  if (Object.keys(next).length > 0) rest.agentPresets = next;
  else delete rest.agentPresets;
  return rest;
}

function commit(draft: Manifest, next: Record<string, AgentPreset>, name: string): PresetOpResult {
  const fault = validateAgentPresetsDraft(next, CAPABILITIES);
  return fault ? refuse(fault) : { ok: true, draft: withPresets(draft, next), name };
}

/** A new, empty preset (all roles inherit) under a free name. */
export function addPreset(draft: Manifest, base = 'new-preset'): PresetOpResult {
  const map = presetMap(draft);
  if (Object.keys(map).length >= MAX_AGENT_PRESETS) {
    return refuse(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
  }
  const name = Object.prototype.hasOwnProperty.call(map, base) ? duplicateName(base, new Set(Object.keys(map))) : base;
  return commit(draft, { ...map, [name]: { slots: {} } as AgentPreset }, name);
}

export function duplicatePreset(draft: Manifest, from: string): PresetOpResult {
  const map = presetMap(draft);
  const source = map[from];
  if (!source) return refuse(`There is no preset named "${from}".`);
  if (Object.keys(map).length >= MAX_AGENT_PRESETS) {
    return refuse(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
  }
  const name = duplicateName(from, new Set(Object.keys(map)));
  const copy = slotsFormPreset(source, CAPABILITIES);
  if (copy.label) copy.label = `${copy.label} copy`;
  return commit(draft, { ...map, [name]: copy as AgentPreset }, name);
}

export function renamePreset(
  draft: Manifest,
  lastSaved: Manifest | undefined,
  from: string,
  to: string,
  roleLabelOf: (key: string) => string | undefined,
): PresetOpResult {
  const map = presetMap(draft);
  if (to.length > 512) return refuse('Preset name must be 512 characters or fewer.');
  if (to.trim() === '') return refuse('Preset name must not be blank.');
  if (to === from) return { ok: true, draft, name: from };
  if (Object.prototype.hasOwnProperty.call(map, to)) return refuse(`A preset named "${to}" already exists.`);
  const refs = presetReferences(from, draft, lastSaved, roleLabelOf);
  if (refs.length > 0) {
    return refuse(`Cannot rename "${from}" — still used by ${joinPresetRefs(refs)}. Change that first.`);
  }
  const next: Record<string, AgentPreset> = {};
  for (const [key, value] of Object.entries(map)) {
    next[key === from ? to : key] = (key === from ? (slotsFormPreset(value, CAPABILITIES) as AgentPreset) : value);
  }
  return commit(draft, next, to);
}

export function deletePreset(
  draft: Manifest,
  lastSaved: Manifest | undefined,
  name: string,
  roleLabelOf: (key: string) => string | undefined,
): PresetOpResult {
  const refs = presetReferences(name, draft, lastSaved, roleLabelOf);
  if (refs.length > 0) {
    return refuse(`Cannot delete "${name}" — still used by ${joinPresetRefs(refs)}. Change that first.`);
  }
  const next = { ...presetMap(draft) };
  delete next[name];
  return { ok: true, draft: withPresets(draft, next), name };
}

/** Make `name` the active preset (canonical key; the Save renames the legacy alias away). */
export function activatePreset(draft: Manifest, name: string): Manifest {
  const rest = { ...draft };
  if (name === '') delete rest.activeAgentPreset;
  else rest.activeAgentPreset = name;
  return rest;
}
