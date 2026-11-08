import { describe, expect, it } from 'vitest';
import { gatePoolName } from './gateLease.js';

describe('gatePoolName', () => {
  it('keeps distinct gate names distinct and path-safe', () => {
    expect(gatePoolName('sast')).toBe('sast');
    expect(gatePoolName('test:unit')).not.toBe(gatePoolName('test_unit'));
    expect(gatePoolName('a/b')).not.toContain('/');
    expect(gatePoolName('..')).toBe('%2E%2E');
  });
});
