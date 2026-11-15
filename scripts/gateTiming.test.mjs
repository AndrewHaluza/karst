import { describe, expect, it } from 'vitest';
import { formatTiming, phaseClock } from './gateTiming.mjs';

describe('phaseClock', () => {
  it('records the time since the last lap, and gives a copy of the list', () => {
    const times = [100, 250, 1250];
    const clock = phaseClock(() => times.shift());
    clock.lap('plan');
    clock.lap('sweep');
    const phases = clock.phases();
    expect(phases).toEqual([
      { name: 'plan', ms: 150 },
      { name: 'sweep', ms: 1000 },
    ]);
    phases[0].ms = 0;
    expect(clock.phases()[0].ms).toBe(150);
  });
});

describe('formatTiming', () => {
  it('gives one line with each phase in seconds', () => {
    expect(
      formatTiming([
        { name: 'plan', ms: 4100 },
        { name: 'wait', ms: 0 },
        { name: 'sweep', ms: 412000 },
      ]),
    ).toBe('visual timing: plan 4.1 s, wait 0.0 s, sweep 412.0 s');
  });

  it('gives null for an empty list', () => {
    expect(formatTiming([])).toBeNull();
  });

  it('shows a negative or non-finite time as 0.0 s', () => {
    expect(
      formatTiming([
        { name: 'a', ms: -5 },
        { name: 'b', ms: Number.NaN },
        { name: 'c', ms: Number.POSITIVE_INFINITY },
      ]),
    ).toBe('visual timing: a 0.0 s, b 0.0 s, c 0.0 s');
  });
});
