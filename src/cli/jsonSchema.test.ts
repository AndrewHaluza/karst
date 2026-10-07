import { describe, it, expect } from 'vitest';
import { validateJson, type JsonSchema } from './jsonSchema.js';

const objectSchema: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 0 },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    mode: { type: 'string', enum: ['a', 'b'] },
    nested: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
  required: ['title'],
  additionalProperties: false,
};

describe('validateJson', () => {
  it('accepts a valid object', () => {
    expect(
      validateJson(objectSchema, {
        title: 'x',
        count: 2,
        tags: ['a'],
        mode: 'a',
        nested: { ok: true },
      }),
    ).toBeNull();
  });

  it('rejects a non-object at the root', () => {
    expect(validateJson(objectSchema, 'nope')).toMatch(/expected object, got string/);
  });

  it('names a missing required property', () => {
    expect(validateJson(objectSchema, {})).toMatch(/missing required property 'title'/);
  });

  it('rejects an unknown property when additionalProperties is false', () => {
    expect(validateJson(objectSchema, { title: 'x', extra: 1 })).toMatch(
      /unknown property 'extra'/,
    );
  });

  it('allows unknown properties when additionalProperties is unset', () => {
    expect(validateJson({ type: 'object' }, { anything: 1 })).toBeNull();
  });

  it('validates unknown property values when additionalProperties is a schema', () => {
    const map: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } };
    expect(validateJson(map, { A: '1', B: '2' })).toBeNull();
    expect(validateJson(map, { A: { nested: true } })).toMatch(
      /\$\.A: expected string, got object/,
    );
    expect(validateJson(map, { A: 1 })).toMatch(/\$\.A: expected string, got integer/);
  });

  it('treats Object.prototype-colliding keys as ordinary property names', () => {
    // A declared-properties schema rejects them like any unknown key...
    expect(validateJson(objectSchema, JSON.parse('{"title":"x","toString":"boom"}'))).toMatch(
      /unknown property 'toString'/,
    );
    expect(validateJson(objectSchema, JSON.parse('{"title":"x","__proto__":"boom"}'))).toMatch(
      /unknown property '__proto__'/,
    );
    // ...and an additionalProperties schema validates their values normally.
    const map: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } };
    expect(validateJson(map, JSON.parse('{"constructor":"v"}'))).toBeNull();
    expect(validateJson(map, JSON.parse('{"__proto__":"v"}'))).toBeNull();
    expect(validateJson(map, JSON.parse('{"constructor":2}'))).toMatch(
      /\$\.constructor: expected string, got integer/,
    );
  });

  it('reports the path of a bad nested field', () => {
    expect(validateJson(objectSchema, { title: 'x', nested: {} })).toMatch(
      /\$\.nested: missing required property 'ok'/,
    );
    expect(validateJson(objectSchema, { title: 'x', count: -1 })).toMatch(
      /\$\.count: must be >= 0/,
    );
    expect(validateJson(objectSchema, { title: 'x', tags: [] })).toMatch(
      /\$\.tags: must have at least 1 item/,
    );
    expect(validateJson(objectSchema, { title: 'x', mode: 'c' })).toMatch(
      /\$\.mode: expected one of "a", "b"/,
    );
    expect(validateJson(objectSchema, { title: '' })).toMatch(
      /\$\.title: must be at least 1 character/,
    );
  });

  it('reports the index of a bad array element', () => {
    expect(validateJson(objectSchema, { title: 'x', tags: ['a', 2] })).toMatch(
      /\$\.tags\[1\]: expected string, got integer/,
    );
  });

  it('enforces a string pattern', () => {
    const noComma: JsonSchema = { type: 'array', items: { type: 'string', pattern: '^[^,]*$' } };
    expect(validateJson(noComma, ['a', 'b'])).toBeNull();
    expect(validateJson(noComma, ['a,b'])).toMatch(/\$\[0\]: must match \^\[\^,\]\*\$/);
  });

  it('accepts an integer for a number schema and rejects a float for an integer schema', () => {
    expect(validateJson({ type: 'number' }, 1)).toBeNull();
    expect(validateJson({ type: 'number' }, 1.5)).toBeNull();
    expect(validateJson({ type: 'integer' }, 1.5)).toMatch(/expected integer, got number/);
  });

  it('rejects null for every type', () => {
    expect(validateJson({ type: 'string' }, null)).toMatch(/got null/);
    expect(validateJson({ type: 'boolean' }, null)).toMatch(/got null/);
  });
});
