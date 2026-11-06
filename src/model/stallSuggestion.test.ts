import { describe, expect, it } from 'vitest';
import { parseStallSuggestion, withAcceptOption, ACCEPT_OPTION_LABEL } from './stallSuggestion.js';

const good = {
  cause: 'The fixes likely patch a design that cannot hold the rule.',
  options: [
    { label: 'Split the module', note: 'Split it.', recommended: true },
    { label: 'Cut scope', note: 'Drop X.', description: 'New text', acceptanceCheck: 'New check' },
  ],
};

describe('parseStallSuggestion', () => {
  it('accepts a valid answer and fills defaults', () => {
    const r = parseStallSuggestion(JSON.stringify(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.options).toHaveLength(2);
    expect(r.value.options[1]).toMatchObject({ recommended: false, description: 'New text', acceptanceCheck: 'New check' });
    expect(r.value.options[0]!.kind).toBe('agent');
  });
  it('reads JSON out of a code fence and chat text', () => {
    const r = parseStallSuggestion('Here:\n```json\n' + JSON.stringify(good) + '\n```\nDone.');
    expect(r.ok).toBe(true);
  });
  it.each([
    ['bad JSON', '{nope'],
    ['not an object', '[1]'],
    ['no cause', JSON.stringify({ ...good, cause: '  ' })],
    ['no options', JSON.stringify({ ...good, options: [] })],
    ['four options', JSON.stringify({ ...good, options: Array.from({ length: 4 }, (_, i) => ({ label: `l${i}`, note: 'n', recommended: i === 0 })) })],
    ['two recommended', JSON.stringify({ ...good, options: good.options.map((o) => ({ ...o, recommended: true })) })],
    ['none recommended', JSON.stringify({ ...good, options: good.options.map((o) => ({ ...o, recommended: false })) })],
    ['empty note', JSON.stringify({ ...good, options: [{ label: 'a', note: '', recommended: true }] })],
    ['non-string description', JSON.stringify({ ...good, options: [{ label: 'a', note: 'n', description: 3, recommended: true }] })],
  ])('refuses %s', (_name, raw) => {
    const r = parseStallSuggestion(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
  it('drops a blank optional replacement text', () => {
    const r = parseStallSuggestion(JSON.stringify({ cause: 'c', options: [{ label: 'a', note: 'n', description: ' ', recommended: true }] }));
    expect(r.ok && r.value.options[0]!.description).toBeUndefined();
  });
});

describe('withAcceptOption', () => {
  const parsed = parseStallSuggestion(JSON.stringify(good));
  it('appends a host option that is never recommended', () => {
    if (!parsed.ok) throw new Error('setup');
    const out = withAcceptOption(parsed.value, 3);
    const last = out.options[out.options.length - 1]!;
    expect(last).toMatchObject({ kind: 'accept-docs', label: ACCEPT_OPTION_LABEL, recommended: false });
    expect(last.note).toContain('3');
    expect(last.note).toMatch(/stay unfixed/);
  });
  it('replaces any accept option that came from the agent', () => {
    if (!parsed.ok) throw new Error('setup');
    const forged = { ...parsed.value, options: [...parsed.value.options, { label: 'x', note: 'n', recommended: false, kind: 'accept-docs' as const }] };
    const out = withAcceptOption(forged, 0);
    expect(out.options.filter((o) => o.kind === 'accept-docs')).toHaveLength(1);
  });
});
