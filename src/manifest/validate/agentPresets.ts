/**
 * Validate the top-level `agentPresets:` map and `defaultAgentPreset:` name,
 * and assert that every manifest-level reference names a defined preset.
 *
 * Mirrors `validate/processAssignments.ts`: every absent field is defaulted,
 * every unknown key is refused with the field named, and reference integrity is
 * checked for values this pure loader can see. The ticket-level preset is store
 * data and is NOT checked here — a dangling ticket reference degrades to "no
 * preset" at resolution, and the ticket form surfaces it.
 */

import { ManifestError } from '../error.js';
import type {
  AgentPreset,
  AgentProvider,
  ProcessAssignmentsConfig,
} from '../types.js';

const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];

/** Model id bound — mirrors the graph profile model grammar. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/;

/** A typo must not turn one method into an unbounded config block. */
const MAX_AGENT_PRESETS = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 512) {
    throw new ManifestError(`${where} must be a non-empty string of at most 512 characters`);
  }
  return v;
}

function assertKnownKeys(raw: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!(known as readonly string[]).includes(key)) {
      throw new ManifestError(`${where} has unknown key "${key}"`);
    }
  }
}

function validatePreset(raw: unknown, where: string): AgentPreset {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['provider', 'model', 'effort'], where);

  const provider = requireString(raw.provider, `${where}.provider`);
  if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ManifestError(`${where}.provider must be one of: ${AGENT_PROVIDERS.join(', ')}`);
  }
  const model = requireString(raw.model, `${where}.model`);
  if (!MODEL_ID.test(model)) {
    throw new ManifestError(`${where}.model is not a valid model id`);
  }
  const preset: AgentPreset = { provider: provider as AgentProvider, model };
  if (raw.effort !== undefined) preset.effort = requireString(raw.effort, `${where}.effort`);
  return preset;
}

export function validateAgentPresets(raw: unknown): Record<string, AgentPreset> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('agentPresets must be a mapping');
  const keys = Object.keys(raw);
  if (keys.length > MAX_AGENT_PRESETS) {
    throw new ManifestError(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
  }
  const presets: Record<string, AgentPreset> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim() === '') throw new ManifestError('agentPresets has an empty preset name');
    presets[name] = validatePreset(value, `agentPresets.${name}`);
  }
  return presets;
}

export function validateDefaultAgentPreset(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ManifestError('defaultAgentPreset must be a string');
  return raw.trim() === '' ? undefined : raw;
}

/**
 * Every manifest-level preset reference must resolve. A dangling
 * `defaultAgentPreset` or `processes.<key>.preset` would otherwise silently do
 * nothing, which reads as "the preset was ignored".
 */
export function assertAgentPresetReferences(
  presets: Record<string, AgentPreset> | undefined,
  defaultAgentPreset: string | undefined,
  processes: ProcessAssignmentsConfig | undefined,
): void {
  const defined = presets ?? {};
  if (defaultAgentPreset !== undefined && !(defaultAgentPreset in defined)) {
    throw new ManifestError(
      `defaultAgentPreset "${defaultAgentPreset}" names no agent preset — ` +
        'define it under agentPresets or remove the field',
    );
  }
  for (const [key, cfg] of Object.entries(processes ?? {})) {
    const name = cfg.preset;
    if (name !== undefined && !(name in defined)) {
      throw new ManifestError(
        `processes.${key}.preset "${name}" names no agent preset — ` +
          'define it under agentPresets or remove the field',
      );
    }
  }
}
