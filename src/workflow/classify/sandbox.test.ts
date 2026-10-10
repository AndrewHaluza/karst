import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { withEmptyCwd } from './sandbox.js';

describe('withEmptyCwd', () => {
  it('hands an existing empty dir and removes it afterwards', async () => {
    let seen = '';
    await withEmptyCwd(async (cwd) => {
      seen = cwd;
      expect(readdirSync(cwd)).toEqual([]);
    });
    expect(existsSync(seen)).toBe(false);
  });
  it('removes the dir when fn throws', async () => {
    let seen = '';
    await expect(
      withEmptyCwd(async (cwd) => {
        seen = cwd;
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(existsSync(seen)).toBe(false);
  });
});
