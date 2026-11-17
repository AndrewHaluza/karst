import type { JsonSchema } from '../jsonSchema.js';
import { BLOCKING_SEVERITIES } from '../../manifest/qualityDefaults.js';
import {
  BOOLEAN,
  NON_EMPTY_STRING,
  TRIMMED_PATH,
  TRIMMED_STRING,
  STRING,
  arrayOf,
  enumOf,
  integer,
  lenientObject,
  orNull,
  ref,
  stringMap,
} from './shared.js';

const GATE_PROPERTIES: Record<string, JsonSchema> = {
  name: TRIMMED_STRING,
  repo: STRING,
  sandbox: enumOf(['host', 'inside']),
  onResourceKill: enumOf(['retry-then-park', 'park', 'host']),
  maxConcurrent: integer(1),
  timeoutMinutes: integer(1),
  enabled: BOOLEAN,
  report: STRING,
  script: TRIMMED_STRING,
  command: TRIMMED_STRING,
  args: arrayOf(STRING),
};

const GATE: JsonSchema = {
  anyOf: [
    lenientObject({ ...GATE_PROPERTIES, kind: { const: 'script' } }, ['name', 'kind', 'script']),
    lenientObject({ ...GATE_PROPERTIES, kind: { const: 'command' } }, ['name', 'kind', 'command']),
  ],
};

const KEY_LIST = arrayOf(TRIMMED_STRING);
const SEVERITY = enumOf(BLOCKING_SEVERITIES);
const GATES = arrayOf(ref('gate'));

const HARNESS = lenientObject(
  {
    name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
    whenChanged: arrayOf(TRIMMED_PATH, { minItems: 1 }),
    start: TRIMMED_STRING,
    stop: TRIMMED_STRING,
    evidence: TRIMMED_PATH,
    startTimeoutSeconds: integer(1),
    description: STRING,
  },
  ['name', 'whenChanged', 'start', 'stop', 'evidence'],
);

const UAT = lenientObject({
  testDir: STRING,
  maxFixAttempts: integer(1),
  stallTimeoutMinutes: integer(1),
  gates: GATES,
  probeWhenAllDisabled: BOOLEAN,
  keepStackForUser: BOOLEAN,
  testerVerifier: ref('gate'),
  testerObservations: lenientObject({
    blockingSeverity: SEVERITY,
    onSkip: enumOf(['pass', 'reask', 'reask-then-park']),
    requireEvidence: lenientObject({ file: TRIMMED_PATH, whenChanged: arrayOf(TRIMMED_PATH, { minItems: 1 }) }, [
      'file',
      'whenChanged',
    ]),
  }),
  tester: lenientObject({ tokenBudget: integer(1) }),
  baselineReview: lenientObject({ paths: arrayOf(TRIMMED_PATH) }),
  harnesses: arrayOf(HARNESS),
  env: stringMap(),
  secrets: KEY_LIST,
  passthrough: KEY_LIST,
  origins: arrayOf({ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9+.-]*://[^/\\s]' }),
  authBootstrap: lenientObject({ path: TRIMMED_STRING, secrets: KEY_LIST }, ['path']),
  author: lenientObject({ enabled: BOOLEAN, agent: STRING }),
  repositories: {
    type: 'object',
    additionalProperties: lenientObject({ env: stringMap(), secrets: KEY_LIST, gates: GATES, testDir: STRING }),
  },
});

const REVIEW = lenientObject({
  maxFixAttempts: integer(1),
  stallTimeoutMinutes: integer(1),
  requireIndependentSignal: BOOLEAN,
  openChanges: BOOLEAN,
  probeWhenAllDisabled: BOOLEAN,
  gates: GATES,
  findings: lenientObject({ enabled: BOOLEAN, blockingSeverity: SEVERITY, maxFindings: integer(1) }),
  stallDetection: lenientObject({
    enabled: BOOLEAN,
    sameFileRounds: integer(1),
    repeatedFindingRounds: orNull(integer(1)),
  }),
  repositories: { type: 'object', additionalProperties: lenientObject({ gates: GATES }) },
});

/**
 * Quality tab: `uat` and `review`. Validator-only: `review.repositories` names
 * must be declared repositories, `repeatedFindingRounds <= maxFixAttempts`, and
 * the URL parse of each `uat.origins` entry.
 */
export const QUALITY_SCHEMA: JsonSchema = {
  type: 'object',
  $defs: { gate: GATE },
  properties: { uat: UAT, review: REVIEW },
};

