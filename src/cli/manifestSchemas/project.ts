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
 * Manifest keys no Settings section claims (`SECTION_FIELDS`): the project `id`
 * and the keys Settings never edits. They get a schema so a typed setup tool
 * can still reach every field.
 */
export const PROJECT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: STRING,
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
