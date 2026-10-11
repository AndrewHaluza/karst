/**
 * Codex `--output-schema` feeds OpenAI strict structured outputs: every object
 * must list ALL its properties in `required` (optional = nullable type), and
 * validation keywords such as `minLength`/`minimum` are not guaranteed to be
 * accepted. The shared contract (`outputContract.ts`) keeps optional keys for
 * claude `--json-schema`, so codex gets this derived strict copy instead.
 *
 * Pure — no I/O. Never mutates its input.
 */

import type { JsonSchemaDocument } from './adapter.js';

/** Keywords strict mode may reject; they only tighten, so dropping is safe (the parser re-validates). */
const UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'pattern',
]);

function widenToNullable(schema: JsonSchemaDocument): JsonSchemaDocument {
  const type = schema['type'];
  if (typeof type === 'string') return { ...schema, type: [type, 'null'] };
  if (Array.isArray(type) && !type.includes('null')) return { ...schema, type: [...type, 'null'] };
  return schema;
}

function isRecord(v: unknown): v is JsonSchemaDocument {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns a strict-mode copy of `doc`: all object properties required, originally-optional ones nullable. */
export function toStrictSchema(doc: JsonSchemaDocument): JsonSchemaDocument {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'items' && isRecord(value)) out[key] = toStrictSchema(value);
    else if (key !== 'properties') out[key] = value;
  }
  const props = doc['properties'];
  if (isRecord(props)) {
    const originallyRequired = new Set(Array.isArray(doc['required']) ? (doc['required'] as string[]) : []);
    const strictProps: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(props)) {
      const strict = isRecord(sub) ? toStrictSchema(sub) : sub;
      strictProps[name] = originallyRequired.has(name) || !isRecord(strict) ? strict : widenToNullable(strict);
    }
    out['properties'] = strictProps;
    out['required'] = Object.keys(strictProps);
  }
  return out;
}
