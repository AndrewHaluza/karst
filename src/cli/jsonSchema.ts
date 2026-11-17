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
 * Deliberately a small hand-rolled subset — no dependency, no network. The only
 * reference form is a LOCAL `$ref: '#/$defs/<name>'` into the root schema's
 * `$defs`. Only the keywords the registry and the manifest schemas actually use
 * are supported; an unsupported keyword is a schema authoring bug caught by
 * `unsupportedKeywords` in the schema tests, not silently ignored at the boundary.
 */

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null';

/** Every keyword `validateJson` understands. Anything else is an authoring error. */
export const SUPPORTED_KEYWORDS: readonly string[] = [
  'type',
  'anyOf',
  'oneOf',
  'const',
  'enum',
  '$ref',
  '$defs',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
];

export interface JsonSchema {
  /** Required unless `anyOf`, `oneOf`, `$ref` or `const` is given. */
  type?: JsonSchemaType;
  /** Valid when at least one alternative validates (alternatives carry their own `type`). */
  anyOf?: readonly JsonSchema[];
  /** Valid when EXACTLY ONE alternative validates (a mutually exclusive choice). */
  oneOf?: readonly JsonSchema[];
  /** The value must equal this scalar exactly. */
  const?: string | number | boolean | null;
  /** Local reference to a root definition: `#/$defs/<name>`. */
  $ref?: string;
  /** Root only: reusable definitions that `$ref` points at. */
  $defs?: Readonly<Record<string, JsonSchema>>;
  description?: string;
  /** Object only: property schemas. */
  properties?: Readonly<Record<string, JsonSchema>>;
  /** Object only: property names that must be present. */
  required?: readonly string[];
  /** Object only: `false` rejects unknown keys, a schema validates their values. */
  additionalProperties?: boolean | JsonSchema;
  /** Object only: every property NAME must validate against this (string) schema. */
  propertyNames?: JsonSchema;
  /** Object only: minimum number of properties. */
  minProperties?: number;
  /** Object only: maximum number of properties. */
  maxProperties?: number;
  /** Array only: the element schema. */
  items?: JsonSchema;
  /** Scalar only: the allowed values. */
  enum?: readonly (string | number | boolean)[];
  /** String only: minimum code-unit length. */
  minLength?: number;
  /** String only: maximum code-unit length. */
  maxLength?: number;
  /** String only: a regular expression the value must match (unanchored, like JSON Schema). */
  pattern?: string;
  /** Array only: minimum number of elements. */
  minItems?: number;
  /** Array only: maximum number of elements. */
  maxItems?: number;
  /** Integer/number only: inclusive lower bound. */
  minimum?: number;
  /** Integer/number only: inclusive upper bound. */
  maximum?: number;
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
    case 'null':
      return actual === 'null';
  }
}

const LOCAL_REF = /^#\/\$defs\/([^/]+)$/;

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  const match = LOCAL_REF.exec(ref);
  const name = match?.[1];
  if (name === undefined || root.$defs === undefined) return null;
  return Object.prototype.hasOwnProperty.call(root.$defs, name) ? root.$defs[name]! : null;
}

/**
 * Validate `value` against `schema`. Returns the first error as a
 * human-readable string (path-prefixed) or `null` when valid.
 * `root` is the schema that owns `$defs`; it defaults to `schema`.
 */
export function validateJson(
  schema: JsonSchema,
  value: unknown,
  path = '$',
  root: JsonSchema = schema,
): string | null {
  if (schema.$ref !== undefined) {
    const target = resolveRef(schema.$ref, root);
    if (target === null) return `${path}: unresolved $ref '${schema.$ref}'`;
    return validateJson(target, value, path, root);
  }
  if (schema.anyOf !== undefined) {
    const errors: string[] = [];
    for (const alt of schema.anyOf) {
      const err = validateJson(alt, value, path, root);
      if (err === null) return null;
      errors.push(err);
    }
    return `${path}: matches none of the alternatives (${errors.join('; ')})`;
  }
  if (schema.oneOf !== undefined) return validateOneOf(schema.oneOf, value, path, root);
  if (schema.const !== undefined) {
    return value === schema.const ? null : `${path}: must equal ${JSON.stringify(schema.const)}`;
  }
  if (schema.type === undefined) return `${path}: schema has neither type nor anyOf`;
  if (!typeMatches(schema.type, value)) {
    return `${path}: expected ${schema.type}, got ${typeOf(value)}`;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) {
    return `${path}: expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  if (schema.type === 'string') return validateString(schema, value as string, path);
  if (schema.type === 'integer' || schema.type === 'number') {
    return validateNumber(schema, value as number, path);
  }
  if (schema.type === 'array') return validateArray(schema, value as unknown[], path, root);
  if (schema.type === 'object') {
    return validateObject(schema, value as Record<string, unknown>, path, root);
  }
  return null;
}

function validateOneOf(
  alternatives: readonly JsonSchema[],
  value: unknown,
  path: string,
  root: JsonSchema,
): string | null {
  const errors: string[] = [];
  let matched = 0;
  for (const alt of alternatives) {
    const err = validateJson(alt, value, path, root);
    if (err === null) matched++;
    else errors.push(err);
  }
  if (matched === 1) return null;
  if (matched === 0) return `${path}: matches none of the alternatives (${errors.join('; ')})`;
  return `${path}: matches more than one alternative`;
}

function validateString(schema: JsonSchema, value: string, path: string): string | null {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return `${path}: must be at least ${schema.minLength} character(s)`;
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    return `${path}: must be at most ${schema.maxLength} character(s)`;
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    return `${path}: must match ${schema.pattern}`;
  }
  return null;
}

function validateNumber(schema: JsonSchema, value: number, path: string): string | null {
  if (schema.minimum !== undefined && value < schema.minimum) {
    return `${path}: must be >= ${schema.minimum}`;
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    return `${path}: must be <= ${schema.maximum}`;
  }
  return null;
}

function validateArray(
  schema: JsonSchema,
  arr: unknown[],
  path: string,
  root: JsonSchema,
): string | null {
  if (schema.minItems !== undefined && arr.length < schema.minItems) {
    return `${path}: must have at least ${schema.minItems} item(s)`;
  }
  if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
    return `${path}: must have at most ${schema.maxItems} item(s)`;
  }
  if (schema.items !== undefined) {
    for (let i = 0; i < arr.length; i++) {
      const err = validateJson(schema.items, arr[i], `${path}[${i}]`, root);
      if (err !== null) return err;
    }
  }
  return null;
}

function validateObject(
  schema: JsonSchema,
  obj: Record<string, unknown>,
  path: string,
  root: JsonSchema,
): string | null {
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return `${path}: missing required property '${key}'`;
    }
  }
  const count = Object.keys(obj).length;
  if (schema.minProperties !== undefined && count < schema.minProperties) {
    return `${path}: must have at least ${schema.minProperties} property(ies)`;
  }
  if (schema.maxProperties !== undefined && count > schema.maxProperties) {
    return `${path}: must have at most ${schema.maxProperties} property(ies)`;
  }
  const props = schema.properties ?? {};
  for (const [key, prop] of Object.entries(obj)) {
    if (schema.propertyNames !== undefined) {
      const nameErr = validateJson(schema.propertyNames, key, path, root);
      if (nameErr !== null) return `${path}: property name '${key}': ${nameErr.replace(/^[^:]*: /, '')}`;
    }
    // `hasOwnProperty`, never `props[key]`: a key like `toString`/`constructor`
    // would otherwise resolve to an inherited Object.prototype member and be
    // validated as if it were a schema.
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      if (schema.additionalProperties === false) {
        return `${path}: unknown property '${key}'`;
      }
      if (typeof schema.additionalProperties === 'object') {
        const err = validateJson(schema.additionalProperties, prop, `${path}.${key}`, root);
        if (err !== null) return err;
      }
      continue;
    }
    const err = validateJson(props[key]!, prop, `${path}.${key}`, root);
    if (err !== null) return err;
  }
  return null;
}

/**
 * Every keyword in `schema` that `validateJson` does not understand, as
 * `$.path.keyword`. Schema tests assert this is empty so a typo or an
 * unsupported keyword is an authoring error, not a silently ignored rule.
 */
export function unsupportedKeywords(schema: JsonSchema, path = '$'): string[] {
  const found: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) found.push(`${path}.${key}`);
  }
  const children: [string, JsonSchema | undefined][] = [
    ['items', schema.items],
    ['propertyNames', schema.propertyNames],
    ['additionalProperties', typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined],
  ];
  for (const [key, child] of children) {
    if (child !== undefined) found.push(...unsupportedKeywords(child, `${path}.${key}`));
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    (schema[key] ?? []).forEach((alt, i) => found.push(...unsupportedKeywords(alt, `${path}.${key}[${i}]`)));
  }
  for (const key of ['properties', '$defs'] as const) {
    for (const [name, child] of Object.entries(schema[key] ?? {})) {
      found.push(...unsupportedKeywords(child, `${path}.${key}.${name}`));
    }
  }
  return found;
}
