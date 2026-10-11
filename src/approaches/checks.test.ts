import { describe, it, expect } from 'vitest';
import { effectiveChecks, BUILT_IN_CHECKS } from './checks.js';

describe('effectiveChecks', () => {
  it('uses the declared list when present', () => {
    expect([...effectiveChecks({ id: 'x', checks: ['spec-plan'] })]).toEqual(['spec-plan']);
  });
  it('declared empty list disables the default', () => {
    expect(effectiveChecks({ id: 'speckit', checks: [] }).size).toBe(0);
  });
  it('falls back to the built-in table by id', () => {
    expect(effectiveChecks({ id: 'speckit' })).toEqual(new Set(BUILT_IN_CHECKS.speckit));
  });
  it('unknown approach without checks → empty', () => {
    expect(effectiveChecks({ id: 'mine' }).size).toBe(0);
  });
});
