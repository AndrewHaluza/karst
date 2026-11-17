/**
 * Building blocks shared by the manifest section schemas (@arch:CLI-03).
 *
 * Every schema here uses only the keywords of `src/cli/jsonSchema.ts`
 * (`unsupportedKeywords` is asserted empty in the conformance test).
 */

import type { JsonSchema } from '../jsonSchema.js';

/** A schema no value satisfies. The subset has no `not` and no `false` schema, so a forbidden key uses this. */
export const NEVER: JsonSchema = { type: 'string', enum: [] };

export const BOOLEAN: JsonSchema = { type: 'boolean' };
export const STRING: JsonSchema = { type: 'string' };
export const NON_EMPTY_STRING: JsonSchema = { type: 'string', minLength: 1 };

/** A string with a visible character: some validators trim before they test for empty. */
export const TRIMMED_STRING: JsonSchema = { type: 'string', minLength: 1, pattern: '\\S' };

/** A reference to a definition in the root `$defs` of the same section schema. */
export function ref(name: string): JsonSchema {
  return { $ref: `#/$defs/${name}` };
}

export function integer(minimum: number, maximum?: number): JsonSchema {
  const schema: JsonSchema = { type: 'integer', minimum };
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

export function enumOf(values: readonly string[]): JsonSchema {
  return { type: 'string', enum: values };
}

export function arrayOf(items: JsonSchema, bounds: { minItems?: number; maxItems?: number } = {}): JsonSchema {
  return { type: 'array', items, ...bounds };
}

export function stringMap(): JsonSchema {
  return { type: 'object', additionalProperties: STRING };
}

/** A mapping with a fixed key set; an unknown key is refused. */
export function strictObject(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** A mapping with a known key set whose unknown keys the validator ignores. */
export function lenientObject(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** The validator also accepts an explicit `null` (a YAML key with no value). */
export function orNull(schema: JsonSchema): JsonSchema {
  return { anyOf: [{ type: 'null' }, schema] };
}

/** A TCP port, as `requirePort` demands. */
export const PORT: JsonSchema = integer(1, 65535);

/** A repo-relative path: no leading `/`, no `..` segment. */
export const RELATIVE_PATH: JsonSchema = {
  type: 'string',
  minLength: 1,
  pattern: '^(?!/)(?!.*(^|/)\\.\\.(/|$))',
};

/** A relative path whose validator also refuses a blank value. */
export const TRIMMED_PATH: JsonSchema = { ...RELATIVE_PATH, pattern: `^(?=.*\\S)${RELATIVE_PATH.pattern!.slice(1)}` };
