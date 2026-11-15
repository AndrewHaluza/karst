import { describe, expect, it } from 'vitest';
import { findSecretLines } from './secrets.js';

describe('findSecretLines', () => {
  it('finds one secret line', () => {
    expect(findSecretLines('a = 1\npassword: x\nb = 2')).toEqual([2]);
  });
});
