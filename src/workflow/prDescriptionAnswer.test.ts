import { describe, it, expect } from 'vitest';
import {
  GATE_SET_CHANGED_LINE,
  PR_DESCRIPTION_OUTPUT_SCHEMA,
  prDescriptionOutputRules,
  parsePrDescriptionAnswer,
  renderNarrative,
} from './prDescriptionAnswer.js';
import { toStrictSchema } from '../agent/strictSchema.js';

const valid = { summary: 'Adds **JSON** answers.', behavior: null };

describe('parsePrDescriptionAnswer', () => {
  it('accepts a bare JSON object', () => {
    const r = parsePrDescriptionAnswer(JSON.stringify(valid));
    expect(r).toEqual({ kind: 'ok', answer: { summary: 'Adds **JSON** answers.', behavior: null } });
  });

  it('accepts one ```json fence around the object', () => {
    const r = parsePrDescriptionAnswer('```json\n' + JSON.stringify(valid) + '\n```');
    expect(r.kind).toBe('ok');
  });

  it('ignores unknown keys', () => {
    const r = parsePrDescriptionAnswer(JSON.stringify({ ...valid, extra: 1 }));
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && 'extra' in r.answer).toBe(false);
  });

  it('keeps a behavior value of any shape for the diagram builder to judge', () => {
    for (const behavior of [5, 'graph TD', { before: [], after: [] }]) {
      const r = parsePrDescriptionAnswer(JSON.stringify({ ...valid, behavior }));
      expect(r.kind === 'ok' && r.answer.behavior).toEqual(behavior);
    }
    expect(parsePrDescriptionAnswer(JSON.stringify({ summary: 'S' })).kind).toBe('ok');
  });

  it('reports prose as not-json', () => {
    expect(parsePrDescriptionAnswer('## Summary\n\nDid a thing.').kind).toBe('not-json');
    expect(parsePrDescriptionAnswer('').kind).toBe('not-json');
  });

  it('reports a JSON value that is not an object as invalid', () => {
    expect(parsePrDescriptionAnswer('[1]').kind).toBe('invalid');
    expect(parsePrDescriptionAnswer('"text"').kind).toBe('invalid');
  });

  it.each([
    ['missing summary', { behavior: null }],
    ['empty summary', { summary: '  \n', behavior: null }],
    ['non-string summary', { summary: 3, behavior: null }],
    ['bad whereToLook', { ...valid, whereToLook: 'x' }],
    ['non-string bullet', { ...valid, needsHuman: ['a', 2] }],
    ['non-string risk', { ...valid, risk: 4 }],
  ])('reports %s as invalid', (_name, value) => {
    expect(parsePrDescriptionAnswer(JSON.stringify(value)).kind).toBe('invalid');
  });
});

describe('renderNarrative', () => {
  it('renders only the summary, with no heading, when nothing else is given', () => {
    expect(renderNarrative({ summary: ' Did it. ', behavior: null }, {})).toBe('Did it.');
  });

  it('renders the sections in fixed order and skips empty ones', () => {
    const body = renderNarrative(
      {
        summary: 'S',
        behavior: null,
        whereToLook: ['a.ts', ' ', 'b.ts'],
        risk: 'Low.',
        needsHuman: ['Check X'],
      },
      {},
    );
    expect(body).toBe(
      'S\n\n## Where to look\n\n- a.ts\n- b.ts\n\n## Risk\n\nLow.\n\n## Needs a human\n\n- Check X',
    );
  });

  it('adds the Behavior section after the narrative sections, before the gate line', () => {
    const behavior = { before: [{ label: 'Old' }], after: [{ label: 'New' }] };
    const body = renderNarrative(
      { summary: 'S', behavior, needsHuman: ['Check X'] },
      { gateSetChanged: true },
    );
    const at = (t: string): number => body.indexOf(t);
    expect(at('## Needs a human')).toBeGreaterThan(-1);
    expect(at('## Behavior')).toBeGreaterThan(at('## Needs a human'));
    expect(at(GATE_SET_CHANGED_LINE)).toBeGreaterThan(at('## Behavior'));
    expect(body.match(/```mermaid/gu)).toHaveLength(1);
  });

  it('keeps the narrative and writes a debug line when the behavior is broken', () => {
    const lines: string[] = [];
    const body = renderNarrative(
      { summary: 'S', behavior: { before: [], after: [] } },
      { debug: (m) => void lines.push(m) },
    );
    expect(body).toBe('S');
    expect(lines).toHaveLength(1);
  });

  it('omits empty arrays and blank risk', () => {
    const body = renderNarrative(
      { summary: 'S', behavior: null, whereToLook: [], risk: '  ', needsHuman: [' '] },
      {},
    );
    expect(body).toBe('S');
  });

  it('adds the fixed gate-set line when the gate set changed', () => {
    expect(renderNarrative({ summary: 'S', behavior: null }, { gateSetChanged: true })).toBe(
      `S\n\n${GATE_SET_CHANGED_LINE}`,
    );
  });
});

describe('schema and prose contract agree', () => {
  const schema = PR_DESCRIPTION_OUTPUT_SCHEMA as {
    required: string[];
    properties: Record<string, unknown>;
  };
  it('names every schema key in the prose rules, for every form', () => {
    for (const form of [undefined, 'tool', 'final-document'] as const) {
      const text = prDescriptionOutputRules(form).join('\n');
      for (const key of Object.keys(schema.properties)) expect(text).toContain(`"${key}"`);
    }
  });
  it('requires exactly summary and behavior', () => {
    expect([...schema.required].sort()).toEqual(['behavior', 'summary']);
  });
  it('marks behavior nullable and the prose says null', () => {
    expect((schema.properties.behavior as { type: string[] }).type).toContain('null');
    expect(prDescriptionOutputRules(undefined).join('\n')).toContain('null');
  });
  it('describes behavior as before/after steps with the 1 to 6 bound, in schema and prose', () => {
    const b = schema.properties.behavior as {
      required: string[];
      properties: Record<string, { type: string; items: { required: string[]; properties: Record<string, unknown> } }>;
    };
    expect([...b.required].sort()).toEqual(['after', 'before']);
    for (const side of ['before', 'after'] as const) {
      expect(b.properties[side]!.type).toBe('array');
      expect(b.properties[side]!.items.required).toEqual(['label']);
      expect(Object.keys(b.properties[side]!.items.properties).sort()).toEqual(['kind', 'label']);
    }
    const prose = prDescriptionOutputRules(undefined).join('\n');
    for (const word of ['"before"', '"after"', '"label"', '"kind"', '"ok"', '"bad"', '1 to 6']) {
      expect(prose).toContain(word);
    }
  });
  it('survives the codex strict copy: every nested object lists all its keys', () => {
    const strict = JSON.stringify(toStrictSchema(PR_DESCRIPTION_OUTPUT_SCHEMA));
    expect(strict).toContain('"required":["label","kind"]');
  });
});
