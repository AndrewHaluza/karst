import { describe, it, expect } from 'vitest';
import { MAX_PROPOSAL_BYTES, PROMPT_SENSITIVE_PATHS, validateProposal } from './proposal.js';

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

  it('accepts the four id/dependsOn combinations and dedupes dependsOn', () => {
    expect(validateProposal({ ...ok })).toEqual({ ok: true, value: ok });
    expect(validateProposal({ ...ok, id: 7 })).toEqual({ ok: true, value: { ...ok, id: 7 } });
    expect(validateProposal({ ...ok, dependsOn: [3, 1] })).toEqual({ ok: true, value: { ...ok, dependsOn: [3, 1] } });
    expect(validateProposal({ ...ok, id: 7, dependsOn: [3, 3, 1] })).toEqual({
      ok: true,
      value: { ...ok, id: 7, dependsOn: [3, 1] },
    });
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
    ['a non-array dependsOn', { ...ok, dependsOn: 7 }],
    ['a string dependsOn entry', { ...ok, dependsOn: ['1'] }],
    ['a zero dependsOn entry', { ...ok, dependsOn: [0] }],
    ['a negative dependsOn entry', { ...ok, dependsOn: [-1] }],
    ['a fractional dependsOn entry', { ...ok, dependsOn: [1.5] }],
    ['too many dependsOn entries', { ...ok, dependsOn: Array.from({ length: 33 }, (_, i) => i + 1) }],
    ['a self-referencing dependsOn', { ...ok, id: 7, dependsOn: [7] }],
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

  describe('constraints', () => {
    const base = { title: 'T', description: 'd', summary: 's', repos: [] };
    it('accepts every entry kind, trims and dedupes keeping order', () => {
      const r = validateProposal({
        ...base,
        constraints: ['@arch:RESIDENT', ' abc1234 ', '#88', 'free text', '#88', '@arch:RESIDENT'],
      });
      expect(r).toEqual({
        ok: true,
        value: { ...base, constraints: ['@arch:RESIDENT', 'abc1234', '#88', 'free text'] },
      });
    });
    it('leaves constraints absent when not supplied', () => {
      const r = validateProposal(base);
      expect(r.ok && 'constraints' in r.value).toBe(false);
    });
    it('accepts exactly 20 entries and an entry of exactly 200 chars', () => {
      const twenty = Array.from({ length: 20 }, (_, i) => `#${i + 1}`);
      expect(validateProposal({ ...base, constraints: twenty }).ok).toBe(true);
      expect(validateProposal({ ...base, constraints: ['x'.repeat(200)] }).ok).toBe(true);
    });
    it.each([
      ['non-array', 'nope'],
      ['a non-string entry', [1]],
      ['an empty entry', ['']],
      ['a blank entry', ['   ']],
      ['an over-long entry', ['x'.repeat(201)]],
      ['more than 20 entries', Array.from({ length: 21 }, (_, i) => `#${i + 1}`)],
    ])('rejects %s', (_l, constraints) => {
      const r = validateProposal({ ...base, constraints });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/constraints/);
    });
    it('rejects agent-supplied hostWarnings', () => {
      const r = validateProposal({ ...base, hostWarnings: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/hostWarnings/);
    });
  });

  it('exports the prompt-sensitive path list', () => {
    expect(PROMPT_SENSITIVE_PATHS).toContain('src/agent/seed.ts');
    expect(PROMPT_SENSITIVE_PATHS).toHaveLength(5);
  });
});
