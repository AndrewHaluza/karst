import { describe, it, expect } from 'vitest';
import { validateAnalysis, codePointersEnabled } from './analysis.js';

describe('validateAnalysis', () => {
  it('returns undefined for an absent block', () => {
    expect(validateAnalysis(undefined)).toBeUndefined();
  });
  it('defaults codePointers to false for an empty block', () => {
    expect(validateAnalysis({})).toEqual({ codePointers: false });
  });
  it('reads true', () => {
    expect(validateAnalysis({ codePointers: true })).toEqual({ codePointers: true });
  });
  it('reads false', () => {
    expect(validateAnalysis({ codePointers: false })).toEqual({ codePointers: false });
  });
  it('rejects a non-boolean codePointers', () => {
    expect(() => validateAnalysis({ codePointers: 'yes' })).toThrow(
      /analysis\.codePointers must be a boolean/,
    );
  });
  it('rejects unknown keys', () => {
    expect(() => validateAnalysis({ foo: 1 })).toThrow(/analysis\.foo is not a known setting/);
  });
  it('rejects a non-mapping block', () => {
    expect(() => validateAnalysis([])).toThrow(/analysis must be a mapping/);
    expect(() => validateAnalysis('on')).toThrow(/analysis must be a mapping/);
    expect(() => validateAnalysis(null)).toThrow(/analysis must be a mapping/);
  });
});

describe('codePointersEnabled', () => {
  it('is false when the block is absent', () => expect(codePointersEnabled({})).toBe(false));
  it('is false when explicitly off', () =>
    expect(codePointersEnabled({ analysis: { codePointers: false } })).toBe(false));
  it('is true when on', () =>
    expect(codePointersEnabled({ analysis: { codePointers: true } })).toBe(true));
});
