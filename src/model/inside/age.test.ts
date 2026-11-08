import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { durationBetween, relativeAge, runAge } from './age.js';

const NOW = '2026-09-06T12:00:00.000Z';

describe('durationBetween', () => {
  it('renders the largest whole unit', () => {
    expect(durationBetween('2026-09-06T11:59:57.000Z', NOW)).toBe('3s');
    expect(durationBetween('2026-09-06T11:57:00.000Z', NOW)).toBe('3m');
    expect(durationBetween('2026-09-06T09:00:00.000Z', NOW)).toBe('3h');
    expect(durationBetween('2026-09-03T12:00:00.000Z', NOW)).toBe('3d');
  });

  it('renders 0s for a sub-second span rather than an empty string', () => {
    expect(durationBetween('2026-09-06T11:59:59.900Z', NOW)).toBe('0s');
  });

  it('clamps a future instant to 0s — a clock ahead is never a negative age', () => {
    expect(durationBetween('2026-09-06T13:00:00.000Z', NOW)).toBe('0s');
  });

  it('returns null for an absent or unparseable instant', () => {
    expect(durationBetween(null, NOW)).toBeNull();
    expect(durationBetween(undefined, NOW)).toBeNull();
    expect(durationBetween('not-a-date', NOW)).toBeNull();
    expect(durationBetween(NOW, 'not-a-date')).toBeNull();
  });
});

describe('relativeAge', () => {
  it('suffixes the duration with ago', () => {
    expect(relativeAge('2026-09-06T11:00:00.000Z', NOW)).toBe('1h ago');
  });

  it('is null when there is nothing to render', () => {
    expect(relativeAge(null, NOW)).toBeNull();
  });
});

describe('runAge', () => {
  it('reports how long an open run has been going', () => {
    expect(
      runAge({ startedAt: '2026-09-06T11:30:00.000Z', endedAt: null }, NOW, { live: true }),
    ).toBe('running 30m');
  });

  it('reports how long a finished run took', () => {
    expect(
      runAge(
        { startedAt: '2026-09-06T11:30:00.000Z', endedAt: '2026-09-06T11:45:00.000Z' },
        NOW,
        { live: false },
      ),
    ).toBe('ran 15m');
  });

  it('falls back to when it ended when the run never recorded a start', () => {
    expect(runAge({ startedAt: null, endedAt: '2026-09-06T11:00:00.000Z' }, NOW, { live: false })).toBe(
      'ended 1h ago',
    );
  });

  it('names a live run that never started — the evidence that it is wrong', () => {
    expect(runAge({ startedAt: null, endedAt: null }, NOW, { live: true })).toBe('never started');
  });

  it('renders nothing for a rest-state run with no timestamps at all', () => {
    expect(runAge({ startedAt: null, endedAt: null }, NOW, { live: false })).toBeNull();
  });
});

describe('durationBetween with a SQLite stamp under a non-UTC time zone', () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  it('reads the stamp as UTC, equal to the ISO stamp', () => {
    expect(durationBetween('2026-08-09 10:00:00', '2026-08-09T10:03:00Z')).toBe('3m');
  });
});
