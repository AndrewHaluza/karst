import { describe, it, expect } from 'vitest';
import { MAX_PROPOSAL_BYTES, validateProposal } from './proposal.js';

const ok = { title: 'Add auth', description: 'Do it\n\tnow', summary: 'Decided X', repos: ['api', 'web.v2'] };

describe('validateProposal', () => {
  it('accepts a well-formed proposal unchanged', () => {
    expect(validateProposal(ok)).toEqual({ ok: true, value: ok });
    expect(MAX_PROPOSAL_BYTES).toBe(65536);
  });

  it('accepts and returns an optional integer id (a revise), without inventing one', () => {
    expect(validateProposal({ ...ok, id: 7 })).toEqual({ ok: true, value: { ...ok, id: 7 } });
    // No id in, no id key out — a create never carries one.
    expect(validateProposal(ok)).toEqual({ ok: true, value: ok });
    expect('id' in (validateProposal(ok) as { value: object }).value).toBe(false);
  });

  it.each([
    ['a non-object', 'x'],
    ['null', null],
    ['an array', []],
    ['an extra key', { ...ok, extra: 1 }],
    ['a missing key', { title: 't', description: '', summary: '' }],
    ['a string id', { ...ok, id: '7' }],
    ['a zero id', { ...ok, id: 0 }],
    ['a negative id', { ...ok, id: -1 }],
    ['a fractional id', { ...ok, id: 1.5 }],
    ['a null id', { ...ok, id: null }],
    ['a non-string title', { ...ok, title: 3 }],
    ['an empty title', { ...ok, title: '  ' }],
    ['a multi-line title', { ...ok, title: 'a\nb' }],
    ['a long title', { ...ok, title: 'x'.repeat(201) }],
    ['a long description', { ...ok, description: 'x'.repeat(32 * 1024 + 1) }],
    ['a long summary', { ...ok, summary: 'x'.repeat(32 * 1024 + 1) }],
    ['non-array repos', { ...ok, repos: 'api' }],
    ['too many repos', { ...ok, repos: Array.from({ length: 33 }, (_, i) => `r${i}`) }],
    ['a bad repo name', { ...ok, repos: ['../etc'] }],
    ['a non-string repo', { ...ok, repos: [1] }],
  ])('rejects %s', (_label, raw) => {
    const r = validateProposal(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\w/);
  });

  it('strips C0/C1 and bidi controls, keeping newline and tab in the bodies', () => {
    const r = validateProposal({
      title: 'A‮b\u0007c\u0085',
      description: 'l1\nl2\t⁦x‏\u001b[31m',
      summary: 's\r\u009b',
      repos: [],
    });
    expect(r).toEqual({ ok: true, value: { title: 'Abc', description: 'l1\nl2\tx[31m', summary: 's', repos: [] } });
  });
});
