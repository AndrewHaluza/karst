import { describe, it, expect } from 'vitest';
import {
  GATE_SET_CHANGED_LINE,
  PR_DESCRIPTION_OUTPUT_SCHEMA,
  prDescriptionOutputRules,
  parsePrDescriptionAnswer,
  renderNarrative,
} from './prDescriptionAnswer.js';

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
    ['non-string behavior', { ...valid, behavior: 5 }],
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
        behavior: 'graph TD',
        whereToLook: ['a.ts', ' ', 'b.ts'],
        risk: 'Low.',
        needsHuman: ['Check X'],
      },
      {},
    );
    expect(body).toBe(
      'S\n\n## Where to look\n\n- a.ts\n- b.ts\n\n## Risk\n\nLow.\n\n## Needs a human\n\n- Check X',
    );
    expect(body).not.toContain('graph TD');
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
});
