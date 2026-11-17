import type { JsonSchema } from '../../cli/jsonSchema.js';
import { BOOLEAN, NON_EMPTY_STRING, TRIMMED_STRING, STRING, arrayOf, enumOf, integer, lenientObject, orNull } from './shared.js';

/** General tab: host, ports, branch, display, templates, archiving, toggles, subtasks. */
export const GENERAL_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['host', 'portRange', 'baselineBranch'],
  properties: {
    host: TRIMMED_STRING,
    portRange: arrayOf({ type: 'number' }, { minItems: 2, maxItems: 2 }),
    baselineBranch: NON_EMPTY_STRING,
    worktreePathDisplay: enumOf(['absolute', 'relative']),
    ticketLabelTemplate: STRING,
    terminalNameTemplate: STRING,
    archiveDoneAfterDays: integer(1),
    archivePlanningAfterDays: integer(1),
    debug: BOOLEAN,
    closeDoneTerminalsWithTicket: BOOLEAN,
    diffsInSourceControl: BOOLEAN,
    stopServersOnDone: enumOf(['ask', 'auto', 'off']),
    subtasks: orNull(
      lenientObject({
        maxConcurrentPerParent: orNull(integer(0)),
        maxConcurrentTotal: orNull(integer(0)),
      }),
    ),
  },
};
