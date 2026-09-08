import { describe, it, expect } from 'vitest';
import { OUTPUT_RULES_BASE } from './promptText.js';
import {
  FINDING_SEVERITIES,
  findingElementSchema,
  REVIEW_OUTPUT_SCHEMA,
  TESTER_OUTPUT_SCHEMA,
} from './outputContract.js';

/**
 * PROMPT-09 — the machine half of the output contract must not drift from the
 * prose half.
 *
 * `OUTPUT_RULES_BASE` is the prose contract a non-structured core is asked to
 * follow; the JSON Schema in `outputContract.ts` is what a structured core's
 * CLI ENFORCES (claude `--json-schema`, codex `--output-schema`). Both describe
 * the SAME element — `{severity, title, detail, file?, line?}` — so a finding
 * produced by either path must parse identically in `review/findings.ts`. These
 * tests pin that equality: a re-worded prose line or a drifted schema cannot
 * slip past each other.
 */
function elementLine(): string {
  // OUTPUT_RULES_BASE[1] is the element shape line shared by both lanes.
  return OUTPUT_RULES_BASE[1]!;
}

function quotedFrom(line: string, names: readonly string[]): string[] {
  return names.filter((n) => line.includes(`"${n}"`));
}

function severityEnumFrom(line: string): string[] {
  const found: string[] = [];
  for (const s of FINDING_SEVERITIES) {
    if (line.includes(`"${s}"`)) found.push(s);
  }
  return found;
}

type ElementLike = {
  required?: unknown[];
  properties?: Record<string, unknown>;
};

/** The `findings` array node of a container schema. */
function findingsArray(schema: unknown): { type?: unknown; items?: unknown } {
  const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  return props.findings as { type?: unknown; items?: unknown };
}

function baseElement(schema: unknown): ElementLike {
  return findingsArray(schema).items as ElementLike;
}

describe('outputContract — prose and schema agree on the element shape', () => {
  it('names exactly the same severity vocabulary as the prose element line', () => {
    const prose = severityEnumFrom(elementLine());
    expect(prose.sort()).toEqual([...FINDING_SEVERITIES].sort());
  });

  it('requires the same fields the prose element line lists', () => {
    const line = elementLine();
    const proseFields = quotedFrom(line, [
      'severity',
      'title',
      'detail',
      'file',
      'line',
    ]);
    const el = baseElement(REVIEW_OUTPUT_SCHEMA);
    const schemaFields = Object.keys(el.properties ?? {});
    expect(schemaFields.sort()).toEqual(proseFields.sort());
    // `file`/`line` are optional in the prose (`file?`/`line?`) and therefore
    // not required in the schema either; severity/title/detail are required.
    expect(el.required).toEqual(['severity', 'title', 'detail']);
  });

  it('pins the review and tester element schemas to the same base shape', () => {
    const review = baseElement(REVIEW_OUTPUT_SCHEMA);
    const tester = baseElement(TESTER_OUTPUT_SCHEMA);
    // The tester variant may only ADD the `criterion` key (Prompt 17); every
    // base field and requirement must be identical so both lanes' findings
    // parse the same way.
    const { criterion: _criterion, ...testerBaseProps } = tester.properties ?? {};
    expect(Object.keys(testerBaseProps).sort()).toEqual(
      Object.keys(review.properties ?? {}).sort(),
    );
    expect(tester.required).toEqual(review.required);
  });

  // A structured-output flag becomes a custom tool whose `input_schema` is this
  // document; the Anthropic API rejects any such schema whose `type` is not
  // "object" ("tools.N.custom.input_schema.type: Input should be 'object'"),
  // which killed every structured Tester/review call before the model ran.
  it('is a top-level JSON object, not a bare array', () => {
    for (const schema of [REVIEW_OUTPUT_SCHEMA, TESTER_OUTPUT_SCHEMA]) {
      expect(schema.type).toBe('object');
    }
  });

  it('carries the findings under a required `findings` array', () => {
    for (const schema of [REVIEW_OUTPUT_SCHEMA, TESTER_OUTPUT_SCHEMA]) {
      expect((schema as { required?: unknown[] }).required).toEqual(['findings']);
      expect(findingsArray(schema).type).toBe('array');
    }
  });

  it('adds a schema-only criterion field to the tester element only', () => {
    expect(baseElement(TESTER_OUTPUT_SCHEMA).properties).toHaveProperty('criterion');
    expect(baseElement(REVIEW_OUTPUT_SCHEMA).properties).not.toHaveProperty('criterion');
  });

  it('is what findingElementSchema builds, so a caller gets the canonical element', () => {
    expect(findingsArray(REVIEW_OUTPUT_SCHEMA).items).toEqual(findingElementSchema());
  });
});