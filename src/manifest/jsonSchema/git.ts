import type { JsonSchema } from '../../cli/jsonSchema.js';
import { TRIMMED_STRING, enumOf, lenientObject } from './shared.js';
import { TICKET_TYPES } from '../../store/ticketTypes.js';

/** Git tab: the artifact conventions. Template syntax is a validator-only rule. */
export const GIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    conventions: lenientObject({
      branchName: TRIMMED_STRING,
      commitMessage: TRIMMED_STRING,
      pullRequestTitle: TRIMMED_STRING,
      pullRequestDescription: TRIMMED_STRING,
      defaultType: enumOf(TICKET_TYPES),
    }),
  },
};
