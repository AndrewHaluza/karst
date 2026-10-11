import { describe, expect, it } from 'vitest';
import { toStrictSchema } from './strictSchema.js';
import { REVIEW_OUTPUT_SCHEMA, TESTER_OUTPUT_SCHEMA } from './outputContract.js';

function element(doc: Record<string, any>): Record<string, any> {
  return doc['properties'].findings.items;
}

describe('toStrictSchema', () => {
  for (const [name, schema] of [
    ['TESTER', TESTER_OUTPUT_SCHEMA],
    ['REVIEW', REVIEW_OUTPUT_SCHEMA],
  ] as const) {
    it(`${name}: every property is required; optional ones nullable`, () => {
      const strict = element(toStrictSchema(schema));
      const orig = element(schema);
      expect([...strict.required].sort()).toEqual(Object.keys(orig.properties).sort());
      expect(strict.additionalProperties).toBe(false);
      for (const key of Object.keys(orig.properties)) {
        const wasRequired = orig.required.includes(key);
        const t = strict.properties[key].type;
        if (wasRequired) expect(t).not.toContain('null');
        else expect(t).toContain('null');
      }
      expect(strict.properties.file.type).toEqual(['string', 'null']);
      expect(strict.properties.line.type).toEqual(['integer', 'null']);
    });
  }

  it('strips unsupported validation keywords', () => {
    const json = JSON.stringify(toStrictSchema(TESTER_OUTPUT_SCHEMA));
    expect(json).not.toMatch(/minLength|minimum/);
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(TESTER_OUTPUT_SCHEMA);
    toStrictSchema(TESTER_OUTPUT_SCHEMA);
    expect(JSON.stringify(TESTER_OUTPUT_SCHEMA)).toBe(before);
  });

  it('keeps top-level container required and unchanged', () => {
    const strict = toStrictSchema(REVIEW_OUTPUT_SCHEMA);
    expect(strict['required']).toEqual(['findings']);
    expect((strict['properties'] as any).findings.type).toBe('array');
  });
});
