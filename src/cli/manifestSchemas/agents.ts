import type { JsonSchema } from '../jsonSchema.js';
import { BACKEND_CORES, allowedBackends } from '../../agent/backendChoices.js';
import { PRESET_CAPABILITIES, type PresetCapability } from '../../manifest/types.js';
import { PROCESS_KEYS } from '../../manifest/validate/processAssignments.js';
import {
  BOOLEAN,
  NON_EMPTY_STRING,
  STRING,
  enumOf,
  integer,
  lenientObject,
  orNull,
  strictObject,
} from './shared.js';

export const AGENT_PROVIDER_VALUES = ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'] as const;
export const MODEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$';
export const MAX_AGENT_PRESETS = 50;

const PROVIDER = enumOf(AGENT_PROVIDER_VALUES);
const SHORT_STRING: JsonSchema = { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' };
const BLANK: JsonSchema = { type: 'string', pattern: '^\\s*$' };

const SLOT = strictObject(
  { provider: PROVIDER, model: { type: 'string', maxLength: 512, pattern: MODEL_ID_PATTERN }, effort: SHORT_STRING },
  ['provider', 'model'],
);

/** What each preset capability drives, so an agent can pick the right slot. */
export const CAPABILITY_DESCRIPTIONS: Record<PresetCapability, string> = {
  uatTester: 'UAT tester process',
  uatFix: 'UAT fix process',
  review: 'review process',
  reviewFix: 'review fix process',
  stallSuggestion: 'stall suggestion process',
  prDescription: 'pull request description process',
  ticketAnalysis: 'ticket analysis process',
  implementation: 'ticket implementation session',
  planning: 'planning process',
  graphExpert: 'expert profile: graph planner and expert nodes',
  graphWorker: 'worker profile: graph worker nodes',
  graphFast: 'fast profile: graph fast nodes',
};

const PRESET: JsonSchema = {
  anyOf: [
    SLOT,
    strictObject(
      {
        label: STRING,
        slots: strictObject(
          Object.fromEntries(PRESET_CAPABILITIES.map((c) => [c, { ...SLOT, description: CAPABILITY_DESCRIPTIONS[c] }])),
        ),
      },
      ['slots'],
    ),
  ],
};

const COMMON_PROCESS: Record<string, JsonSchema> = {
  agentName: STRING,
  agent: STRING,
  preset: STRING,
  enabled: BOOLEAN,
};

/** An unpinned row carries no provider/model/effort; a pinned row needs a provider. */
const PROCESS: JsonSchema = {
  anyOf: [
    lenientObject({ ...COMMON_PROCESS, pinned: { const: false }, provider: BLANK, model: BLANK, effort: BLANK }),
    lenientObject({ ...COMMON_PROCESS, pinned: { const: true }, provider: PROVIDER, model: STRING, effort: STRING }, [
      'pinned',
      'provider',
    ]),
  ],
};

const BACKEND_PROPERTIES: Record<string, JsonSchema> = Object.fromEntries(
  BACKEND_CORES.map((core) => [core, enumOf(allowedBackends(core))]),
);

/** Agents tab: the Default row, per-role pins, presets, agent profiles, backends and quota. */
export const AGENTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    agentProvider: PROVIDER,
    defaultModel: STRING,
    defaultEffort: STRING,
    agents: {
      type: 'object',
      additionalProperties: lenientObject(
        { role: NON_EMPTY_STRING, command: NON_EMPTY_STRING, promptPath: NON_EMPTY_STRING, enabled: BOOLEAN },
        ['role'],
      ),
    },
    processes: strictObject(Object.fromEntries(PROCESS_KEYS.map((k) => [k, PROCESS]))),
    agentPresets: {
      type: 'object',
      maxProperties: MAX_AGENT_PRESETS,
      propertyNames: { type: 'string', pattern: '\\S' },
      additionalProperties: PRESET,
    },
    activeAgentPreset: STRING,
    defaultAgentPreset: STRING,
    agentBackends: strictObject(BACKEND_PROPERTIES),
    quota: orNull(
      strictObject({
        warnThresholdPct: integer(1, 100),
        claudeGlobalStatusline: BOOLEAN,
        claudeOauthUsageApi: BOOLEAN,
      }),
    ),
  },
};

