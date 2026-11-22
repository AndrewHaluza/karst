import type { JsonSchema } from '../jsonSchema.js';
import { DOCKER_MEMORY_PATTERN } from '../../agent/docker/dockerMemory.js';
import {
  BOOLEAN,
  STRING,
  arrayOf,
  integer,
  lenientObject,
  orNull,
  strictObject,
} from './shared.js';

const MEMORY: JsonSchema = { type: 'string', pattern: DOCKER_MEMORY_PATTERN.source };

/**
 * Manifest keys no Settings section claims (`SECTION_FIELDS`): the project `id`,
 * the keys Settings never edits, and `quota` (the Accounts card writes it out of
 * band through `set-quota`, so no tab-scoped Save merges it). They get a schema
 * so a typed setup tool can still reach every field.
 */
export const PROJECT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: STRING,
    // Q4-SAVE: written by the Accounts quota card at once, never by a Save.
    quota: orNull(
      strictObject({
        warnThresholdPct: integer(1, 100),
        claudeGlobalStatusline: BOOLEAN,
        claudeOauthUsageApi: BOOLEAN,
      }),
    ),
    resilience: lenientObject({
      retries: integer(0, 5),
      backoffMs: integer(0, 60000),
      fallbackModels: arrayOf(STRING, { maxItems: 5 }),
    }),
    artifacts: orNull(lenientObject({ maxAgeDays: integer(1) })),
    agentSandbox: BOOLEAN,
    sandboxMemory: strictObject({
      interactiveMemory: MEMORY,
      interactiveReservation: MEMORY,
      gateMemory: MEMORY,
      gateReservation: MEMORY,
      sbxMemory: MEMORY,
      sbxMinFree: MEMORY,
    }),
    sandboxLimits: strictObject({ cpus: integer(1), workers: BOOLEAN, gateSlots: integer(0) }),
    analysis: strictObject({ codePointers: BOOLEAN }),
  },
};
