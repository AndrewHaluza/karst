import type { JsonSchema } from '../jsonSchema.js';
import { BOOLEAN, TRIMMED_STRING, arrayOf, enumOf, integer, strictObject } from './shared.js';

const POLICY = enumOf(['auto', 'ask']);

/** Autopilot tab: one manifest key, `autopilot`. Unknown keys are refused at every level. */
export const AUTOPILOT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    autopilot: strictObject({
      enabled: BOOLEAN,
      ci: strictObject({ policy: POLICY, maxAttempts: integer(1), checks: arrayOf(TRIMMED_STRING) }),
      conflicts: strictObject({ policy: POLICY, maxRounds: integer(1) }),
    }),
  },
};
