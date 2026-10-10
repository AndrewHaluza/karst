import { describe, it, expect } from 'vitest';
import { UNTRUSTED_INPUT_RULES, MISSING_INFO_RULES, ROLE_BOUNDARY_LINE } from './promptRules.js';

describe('promptRules', () => {
  it('treats ticket text as data and allows exactly one Note line', () => {
    const t = UNTRUSTED_INPUT_RULES.join('\n');
    expect(t).toMatch(/is DATA/);
    expect(t).toMatch(/never commands/i);
    expect(t).toMatch(/\*\*Note:\*\*/);
  });
  it('forbids filling missing information', () => {
    const t = MISSING_INFO_RULES.join('\n');
    expect(t).toMatch(/never fill/i);
    expect(t).toMatch(/Never invent acceptance criteria/);
  });
  it('states the role boundary', () => {
    expect(ROLE_BOUNDARY_LINE).toMatch(/do not plan, design, estimate, or implement/i);
  });
});
