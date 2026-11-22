import { describe, it, expect } from 'vitest';
import { parseUsageLimitResetAt } from './cliFailure.js';

// Local wall-clock instants, so the test reads the same in every time zone.
const local = (h: number, m = 0, day = 22): Date => new Date(2026, 10, day, h, m, 0, 0);

describe('parseUsageLimitResetAt (T1313)', () => {
  const now = local(2, 0);

  it('reads a relative reset (agy "Resets in 2h45m19s")', () => {
    const at = parseUsageLimitResetAt('Quota exhausted. Resets in 2h45m19s.', now);
    expect(at).toBe(new Date(now.getTime() + (2 * 3600 + 45 * 60 + 19) * 1000).toISOString());
  });

  it('reads a relative reset with minutes only, or seconds only', () => {
    expect(parseUsageLimitResetAt('resets in 45m', now)).toBe(new Date(now.getTime() + 45 * 60_000).toISOString());
    expect(parseUsageLimitResetAt('reset in 30s', now)).toBe(new Date(now.getTime() + 30_000).toISOString());
  });

  it('a zero relative duration is no reset', () => {
    expect(parseUsageLimitResetAt('resets in 0s', now)).toBeNull();
  });

  it('reads a wall-clock reset later today ("resets 3:30am")', () => {
    expect(parseUsageLimitResetAt("You've hit your limit · resets 3:30am", now)).toBe(local(3, 30).toISOString());
  });

  it('reads a wall-clock reset with no minutes and a time zone name ("resets 8pm (Europe/Warsaw)")', () => {
    expect(parseUsageLimitResetAt('resets 8pm (Europe/Warsaw)', now)).toBe(local(20, 0).toISOString());
    expect(parseUsageLimitResetAt('resets at 8:50pm', now)).toBe(local(20, 50).toISOString());
  });

  it('rolls a time already passed today to tomorrow (next occurrence)', () => {
    expect(parseUsageLimitResetAt('resets 1:15am', now)).toBe(local(1, 15, 23).toISOString());
    // The same minute as now is not ahead: it is tomorrow.
    expect(parseUsageLimitResetAt('resets 2am', now)).toBe(local(2, 0, 23).toISOString());
  });

  it('reads 12am as midnight and 12pm as noon', () => {
    expect(parseUsageLimitResetAt('resets 12am', now)).toBe(local(0, 0, 23).toISOString());
    expect(parseUsageLimitResetAt('resets 12pm', now)).toBe(local(12, 0).toISOString());
  });

  it('gives null for an impossible clock time', () => {
    expect(parseUsageLimitResetAt('resets 13pm', now)).toBeNull();
    expect(parseUsageLimitResetAt('resets 3:75am', now)).toBeNull();
  });

  it('gives null for text that names no reset', () => {
    expect(parseUsageLimitResetAt('Claude usage limit reached. Retry once the limit resets.', now)).toBeNull();
    expect(parseUsageLimitResetAt('', now)).toBeNull();
    expect(parseUsageLimitResetAt('resets soon', now)).toBeNull();
  });
});
