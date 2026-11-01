import { describe, expect, it } from 'vitest';
import { blockingObservationLines } from './tester.js';

const f = (severity: 'high' | 'medium' | 'low' | 'info', title: string, filePath: string | null, line: number | null) => ({
  severity,
  title,
  filePath,
  line,
});

describe('blockingObservationLines', () => {
  it('lists severity, title and file:line at or above the threshold, most severe first', () => {
    expect(
      blockingObservationLines(
        [f('medium', 'no consumer', 'scripts/vitestGate.mjs', 103), f('high', 'broken', null, null), f('low', 'nit', 'a.ts', 1)],
        'medium',
      ),
    ).toEqual(['- [high] broken', '- [medium] no consumer (scripts/vitestGate.mjs:103)']);
  });
  it('omits the line number for a whole-file finding; none yields nothing', () => {
    expect(blockingObservationLines([f('high', 't', 'a.ts', null)], 'low')).toEqual(['- [high] t (a.ts)']);
    expect(blockingObservationLines([f('high', 't', 'a.ts', 1)], 'none')).toEqual([]);
  });
});
