/**
 * One-time, idempotent migration of the pre-pin `processes.<role>` core fields
 * (provider/model/effort on an UNPINNED row) into the preset layer, applied to
 * the RAW YAML tree before validation (like `migrate.ts`).
 *
 * Why: the active preset's slot used to outrank an unpinned Settings row, so a
 * user's Settings edit could be dead without notice. Now an unpinned row
 * carries only `agent` / `enabled`; its core lives in a preset slot or, when
 * the user wants it identical everywhere, in a PIN (`pinned: true`).
 *
 * Per row with core fields (user ruling: fold into the ACTIVE preset):
 *   - the effective preset (row's deprecated `preset`, else the active one)
 *     gets the slot, OVERWRITING any slot it has for the role;
 *   - every OTHER preset with no slot for the role gets a copy (they were
 *     already running the row, so their behavior does not change);
 *   - other presets with their own slot are untouched;
 *   - the row keeps `agent`/`agentName`/`enabled`/`preset`, loses the core.
 * With no usable preset (none defined, no active one, or a dangling name) the
 * row becomes the role's PIN — the only place its value can still live.
 * A row that cannot form a complete slot (no model) is pinned the same way.
 *
 * Pure: returns a new tree, never mutates its input. Nothing is written to
 * disk here; the folded tree is persisted by the next Settings save.
 */

import { PROCESS_KEYS, PROCESS_ROLE_BY_KEY, type ProcessKey } from './validate/processAssignments.js';
import { PRESET_CAPABILITIES, type PresetCapability } from './types.js';
import { DEFAULT_PROCESS_AGENT_NAMES } from '../agent/processAssignment.js';
import { AGENT_PROVIDER_LABELS } from '../model/agentProviders.js';

type Raw = Record<string, unknown>;

export interface FoldResult {
  raw: unknown;
  /** One line per moved row; empty when nothing moved. */
  notices: string[];
}

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** A legacy flat preset ({provider, model}) → the slots form (same slot on every capability). */
function toSlotsForm(preset: Raw): Raw {
  if (preset.provider === undefined && preset.model === undefined) return preset;
  const slot: Raw = {};
  for (const k of ['provider', 'model', 'effort'] as const) {
    if (preset[k] !== undefined) slot[k] = preset[k];
  }
  const slots: Raw = {};
  for (const cap of PRESET_CAPABILITIES) slots[cap] = { ...slot };
  return { ...(preset.label === undefined ? {} : { label: preset.label }), slots };
}

function roleLabel(key: ProcessKey): string {
  const role = PROCESS_ROLE_BY_KEY[key];
  return role === 'pr-description' ? 'PR description' : DEFAULT_PROCESS_AGENT_NAMES[role];
}

function describeSlot(provider: string, model: string, effort?: string): string {
  const label = (AGENT_PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
  return `${label} · ${model}${effort === undefined ? '' : ` · ${effort}`}`;
}

export function foldProcessRows(input: unknown): FoldResult {
  if (!isObject(input) || !isObject(input.processes)) return { raw: input, notices: [] };
  const processesIn = input.processes;
  const needs = PROCESS_KEYS.filter((key) => {
    const row = processesIn[key];
    return (
      isObject(row) &&
      row.pinned !== true &&
      (str(row.provider) !== undefined || str(row.model) !== undefined || str(row.effort) !== undefined)
    );
  });
  if (needs.length === 0) return { raw: input, notices: [] };

  const processes: Raw = { ...processesIn };
  let presets: Raw | undefined = isObject(input.agentPresets) ? { ...input.agentPresets } : undefined;
  const activeName = str(input.activeAgentPreset) ?? str(input.defaultAgentPreset);
  const defaultProvider = str(input.agentProvider) ?? 'claude';
  const notices: string[] = [];

  for (const key of needs) {
    const row = { ...(processes[key] as Raw) };
    const provider = str(row.provider) ?? defaultProvider;
    const model =
      str(row.model) ?? (provider === defaultProvider ? str(input.defaultModel) : undefined);
    const effort = str(row.effort);
    const targetName = [str(row.preset), activeName].find(
      (n) => n !== undefined && presets !== undefined && hasOwn(presets, n) && isObject(presets[n]),
    );

    const label = roleLabel(key);
    if (presets === undefined || targetName === undefined || model === undefined) {
      processes[key] = { ...row, provider, ...(model === undefined ? {} : { model }), pinned: true };
      notices.push(
        `Pinned ${label} (${describeSlot(provider, model ?? '', effort)}): no active preset could hold it.`,
      );
      continue;
    }

    const slot: Raw = { provider, model, ...(effort === undefined ? {} : { effort }) };
    const next: Raw = {};
    for (const [name, value] of Object.entries(presets)) {
      if (!isObject(value)) {
        next[name] = value;
        continue;
      }
      const preset = toSlotsForm(value);
      const slots = isObject(preset.slots) ? preset.slots : {};
      if (name === targetName || !hasOwn(slots, key)) {
        next[name] = { ...preset, slots: { ...slots, [key as PresetCapability]: { ...slot } } };
      } else {
        next[name] = preset;
      }
    }
    presets = next;
    delete row.provider;
    delete row.model;
    delete row.effort;
    processes[key] = row;
    notices.push(
      `Moved ${label} (${describeSlot(provider, model, effort)}) into active preset "${targetName}". ` +
        'Pin a role to keep it the same in all presets.',
    );
  }

  return {
    raw: { ...input, processes, ...(presets === undefined ? {} : { agentPresets: presets }) },
    notices,
  };
}
