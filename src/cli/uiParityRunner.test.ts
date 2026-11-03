import { describe, it, expect } from 'vitest';
import { parseParityFailures } from './uiParityRunner.js';

describe('parseParityFailures', () => {
  it('names mismatched snapshots once each', () => {
    const out = 'Snapshot `regions · a 1` mismatched\nSnapshot `regions · a 1` mismatched\nSnapshot `b 2` mismatched';
    expect(parseParityFailures(out)).toEqual(['regions · a 1', 'b 2']);
  });
  it('falls back to FAIL lines', () => {
    expect(parseParityFailures(' FAIL  src/x.test.ts > case')).toEqual(['src/x.test.ts > case']);
  });
  it('returns empty for clean output', () => {
    expect(parseParityFailures('ok')).toEqual([]);
  });
});
