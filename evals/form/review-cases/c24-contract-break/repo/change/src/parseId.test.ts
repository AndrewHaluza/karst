import { describe, expect, it } from 'vitest';
import { parseId } from './parseId.js';

describe('parseId', () => {
  it('parses a positive integer', () => {
    expect(parseId('42')).toBe(42);
  });
  it('throws on text', () => {
    expect(() => parseId('x')).toThrow(RangeError);
  });
});
