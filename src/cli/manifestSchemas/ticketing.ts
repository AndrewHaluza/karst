import type { JsonSchema } from '../jsonSchema.js';
import { BOOLEAN, NON_EMPTY_STRING, STRING, enumOf, lenientObject } from './shared.js';

const PROVIDERS = ['clickup', 'manual'] as const;

const TICKETING_PROPERTIES: Record<string, JsonSchema> = {
  provider: enumOf(PROVIDERS),
  teamId: NON_EMPTY_STRING,
  listId: NON_EMPTY_STRING,
  advanceOnShip: BOOLEAN,
  shipStatus: STRING,
  advanceOnStart: BOOLEAN,
  startStatus: STRING,
  searchEnabled: BOOLEAN,
  syncSubtasks: enumOf(['off', 'link', 'full']),
};

const NOT_MANUAL = enumOf(PROVIDERS.filter((p) => p !== 'manual'));

/**
 * `advanceOnShip: true` needs a non-blank `shipStatus` and a provider other than
 * `manual`; `advanceOnStart: true` needs a provider other than `manual`.
 */
const withProps = (extra: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema =>
  lenientObject({ ...TICKETING_PROPERTIES, ...extra }, ['provider', ...required]);

export const TICKETING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ticketing: {
      anyOf: [
        withProps({ advanceOnShip: { const: false }, advanceOnStart: { const: false } }),
        withProps({ advanceOnShip: { const: false }, advanceOnStart: { const: true }, provider: NOT_MANUAL }),
        withProps(
          { advanceOnShip: { const: true }, provider: NOT_MANUAL, shipStatus: { type: 'string', pattern: '\\S' } },
          ['shipStatus'],
        ),
      ],
    },
  },
};
