import { describe, it, expect } from 'vitest';
import { REVIEW_GATES, UAT_GATES } from './scripts.js';

describe('REVIEW_GATES', () => {
  it('names the package.json script each gate depends on', () => {
    // The script name is what makes a gate answerable: `npm run lint` in a repo
    // with no lint script exits 1, which is a fact about the repo's config, not
    // about the ticket's code.
    expect(REVIEW_GATES.map((g) => [g.name, g.script])).toEqual([
      ['lint', 'lint'],
      ['typecheck', 'typecheck'],
      ['test', 'test'],
    ]);
  });
});

describe('UAT_GATES', () => {
  it('is a non-empty list whose first entry is the repo test script', () => {
    expect(UAT_GATES.length).toBeGreaterThan(0);
    expect(UAT_GATES[0]).toEqual({ name: 'test', script: 'test', args: ['test'] });
  });
});
