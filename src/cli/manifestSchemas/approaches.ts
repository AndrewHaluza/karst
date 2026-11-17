import type { JsonSchema } from '../jsonSchema.js';
import { ACCESS_VALUES, CWD_VALUES, GRAPH_COMMAND_TIMEOUT_CEILING, GRAPH_HARD_CEILINGS } from '../../manifest/graphConfig.js';
import { CHAIN_EDGES, OUTPUT_KINDS } from '../../manifest/types.js';
import { AGENT_PROVIDER_VALUES, MODEL_ID_PATTERN } from './agents.js';
import {
  BOOLEAN,
  NON_EMPTY_STRING,
  TRIMMED_STRING,
  STRING,
  arrayOf,
  enumOf,
  integer,
  lenientObject,
  strictObject,
} from './shared.js';

const SHORT_STRING: JsonSchema = { type: 'string', minLength: 1, maxLength: 512 };
const ENV_NAME = '^[A-Za-z_][A-Za-z0-9_]{0,127}$';

const SOURCE: JsonSchema = {
  anyOf: [
    lenientObject(
      { type: { const: 'git' }, repo: NON_EMPTY_STRING, ref: NON_EMPTY_STRING, include: arrayOf(NON_EMPTY_STRING, { minItems: 1 }) },
      ['type', 'repo', 'ref', 'include'],
    ),
    lenientObject(
      { type: { const: 'npm' }, package: NON_EMPTY_STRING, command: NON_EMPTY_STRING, collect: arrayOf(NON_EMPTY_STRING) },
      ['type', 'package', 'command', 'collect'],
    ),
  ],
};

const OUTPUT = strictObject({ glob: TRIMMED_STRING, kind: enumOf(OUTPUT_KINDS) }, ['glob', 'kind']);

const PROFILE = strictObject(
  { provider: enumOf(AGENT_PROVIDER_VALUES), model: { type: 'string', maxLength: 512, pattern: MODEL_ID_PATTERN }, effort: SHORT_STRING },
  ['provider', 'model'],
);

const COMMAND = strictObject(
  {
    command: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$', maxLength: 512 },
    args: arrayOf(SHORT_STRING),
    cwd: enumOf(CWD_VALUES),
    access: enumOf(ACCESS_VALUES),
    timeoutSeconds: integer(1, GRAPH_COMMAND_TIMEOUT_CEILING),
    env: {
      type: 'object',
      propertyNames: { type: 'string', pattern: ENV_NAME },
      additionalProperties: { type: 'string', maxLength: 1024 },
    },
  },
  ['command', 'args', 'cwd', 'access', 'timeoutSeconds'],
);

const LIMITS = strictObject(
  Object.fromEntries(Object.entries(GRAPH_HARD_CEILINGS).map(([key, ceiling]) => [key, integer(1, ceiling)])),
);

/** `maxExpertRuns >= maxReplans + 1` is a validator-only rule. */
const GRAPH = strictObject({
  planner: strictObject({ profile: SHORT_STRING, prompt: strictObject({ artifact: SHORT_STRING }, ['artifact']) }, ['profile']),
  profiles: { type: 'object', additionalProperties: PROFILE },
  commands: { type: 'object', additionalProperties: COMMAND },
  limits: LIMITS,
});

const APPROACH = lenientObject(
  {
    id: NON_EMPTY_STRING,
    label: NON_EMPTY_STRING,
    description: NON_EMPTY_STRING,
    entrypoint: NON_EMPTY_STRING,
    source: SOURCE,
    recommended: BOOLEAN,
    workflow: arrayOf(lenientObject({ name: NON_EMPTY_STRING, command: NON_EMPTY_STRING, description: NON_EMPTY_STRING }, ['name'])),
    outputs: arrayOf(OUTPUT),
    checks: arrayOf(enumOf(CHAIN_EDGES)),
    enabled: BOOLEAN,
    graph: GRAPH,
  },
  ['id', 'label'],
);

/** Approaches tab. Unique ids and "at most one recommended" are validator-only rules. */
export const APPROACHES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { approaches: arrayOf(APPROACH) },
};
