/**
 * A tiny JSON Schema (draft 2020-12 subset) validator for the CLI command
 * registry.
 *
 * The CLI already trusts no argv (the invoking agent reads ticket content it
 * did not author), so every command parses its own argv at the boundary. The
 * registry adds a SECOND, declarative check for the structured-JSON input path
 * (`--file` / stdin): one shape definition per command, published by
 * `karst schema` and validated here before a handler ever sees the object.
 *
 * Deliberately a small hand-rolled subset — no dependency, no network, no
 * `$ref`. Only the keywords the registry actually uses are supported; an
 * unsupported keyword is a schema authoring bug caught by the registry tests,
 * not silently ignored at the boundary.
 */

export type JsonSchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';

export interface JsonSchema {
  /** Required unless `anyOf` is given. */
  type?: JsonSchemaType;
  /** Valid when at least one alternative validates (alternatives carry their own `type`). */
  anyOf?: readonly JsonSchema[];
  description?: string;
  /** Object only: property schemas. */
  properties?: Readonly<Record<string, JsonSchema>>;
  /** Object only: property names that must be present. */
  required?: readonly string[];
  /** Object only: `false` rejects unknown keys, a schema validates their values. */
  additionalProperties?: boolean | JsonSchema;
  /** Array only: the element schema. */
  items?: JsonSchema;
  /** Scalar only: the allowed values. */
  enum?: readonly (string | number | boolean)[];
  /** String only: minimum code-unit length. */
  minLength?: number;
  /** String only: a regular expression the whole value must match. */
  pattern?: string;
  /** Array only: minimum number of elements. */
  minItems?: number;
  /** Integer/number only: inclusive lower bound. */
  minimum?: number;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t;
}

function typeMatches(want: JsonSchemaType, value: unknown): boolean {
  const actual = typeOf(value);
  switch (want) {
    case 'object':
      return actual === 'object';
    case 'array':
      return actual === 'array';
    case 'string':
      return actual === 'string';
    case 'integer':
      return actual === 'integer';
    case 'number':
      return actual === 'integer' || actual === 'number';
    case 'boolean':
      return actual === 'boolean';
  }
}

/**
 * Validate `value` against `schema`. Returns the first error as a
 * human-readable string (path-prefixed) or `null` when valid.
 */
export function validateJson(schema: JsonSchema, value: unknown, path = '$'): string | null {
  if (schema.anyOf !== undefined) {
    const errors: string[] = [];
    for (const alt of schema.anyOf) {
      const err = validateJson(alt, value, path);
      if (err === null) return null;
      errors.push(err);
    }
    return `${path}: matches none of the alternatives (${errors.join('; ')})`;
  }
  if (schema.type === undefined) return `${path}: schema has neither type nor anyOf`;
  if (!typeMatches(schema.type, value)) {
    return `${path}: expected ${schema.type}, got ${typeOf(value)}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) {
    return `${path}: expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && (value as string).length < schema.minLength) {
      return `${path}: must be at least ${schema.minLength} character(s)`;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value as string)) {
      return `${path}: must match ${schema.pattern}`;
    }
    return null;
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && (value as number) < schema.minimum) {
      return `${path}: must be >= ${schema.minimum}`;
    }
    return null;
  }
  if (schema.type === 'array') {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      return `${path}: must have at least ${schema.minItems} item(s)`;
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < arr.length; i++) {
        const err = validateJson(schema.items, arr[i], `${path}[${i}]`);
        if (err !== null) return err;
      }
    }
    return null;
  }
  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        return `${path}: missing required property '${key}'`;
      }
    }
    const props = schema.properties ?? {};
    for (const [key, prop] of Object.entries(obj)) {
      // `hasOwnProperty`, never `props[key]`: a key like `toString`/`constructor`
      // would otherwise resolve to an inherited Object.prototype member and be
      // validated as if it were a schema.
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        if (schema.additionalProperties === false) {
          return `${path}: unknown property '${key}'`;
        }
        if (typeof schema.additionalProperties === 'object') {
          const err = validateJson(schema.additionalProperties, prop, `${path}.${key}`);
          if (err !== null) return err;
        }
        continue;
      }
      const err = validateJson(props[key]!, prop, `${path}.${key}`);
      if (err !== null) return err;
    }
    return null;
  }
  return null;
}
