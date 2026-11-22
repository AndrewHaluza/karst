import { describe, it, expect } from 'vitest';
import { formatCalendarDate, formatFullDateTime, formatLongDate } from './dateText.js';

const UTC = { locale: 'en-US', timeZone: 'UTC' } as const;
const NOW = new Date('2026-03-04T12:00:00.000Z');

describe('formatCalendarDate', () => {
  it('shows the time for an instant on the same calendar day', () => {
    expect(formatCalendarDate('2026-03-04T10:42:00.000Z', NOW, UTC)).toBe('10:42');
  });

  it('shows month and day earlier in the same calendar year', () => {
    expect(formatCalendarDate('2026-03-01T23:30:00.000Z', NOW, UTC)).toBe('Mar 1');
    expect(formatCalendarDate('2026-01-09T00:00:00.000Z', NOW, UTC)).toBe('Jan 9');
  });

  it('adds the year when the calendar year differs', () => {
    expect(formatCalendarDate('2025-03-04T10:42:00.000Z', NOW, UTC)).toBe('Mar 4, 2025');
  });

  it('compares calendar days in the chosen zone, not by 24-hour arithmetic', () => {
    // 23:30 UTC on Mar 3 is 00:30 on Mar 4 in Berlin: "today" there, "Mar 3" in UTC.
    const at = '2026-03-03T23:30:00.000Z';
    expect(formatCalendarDate(at, NOW, { locale: 'en-US', timeZone: 'Europe/Berlin' })).toMatch(
      /^\d{2}:\d{2}$/,
    );
    expect(formatCalendarDate(at, NOW, UTC)).toBe('Mar 3');
  });

  it('returns empty for a null, undefined, empty or invalid instant', () => {
    expect(formatCalendarDate(null, NOW, UTC)).toBe('');
    expect(formatCalendarDate(undefined, NOW, UTC)).toBe('');
    expect(formatCalendarDate('', NOW, UTC)).toBe('');
    expect(formatCalendarDate('not a date', NOW, UTC)).toBe('');
  });

  it('returns empty for an invalid now', () => {
    expect(formatCalendarDate('2026-03-04T10:42:00.000Z', new Date('nope'), UTC)).toBe('');
  });
});

describe('formatLongDate', () => {
  it('always carries the year', () => {
    expect(formatLongDate('2026-03-04T10:42:00.000Z', UTC)).toBe('Mar 4, 2026');
    expect(formatLongDate('2025-12-31T23:59:00.000Z', UTC)).toBe('Dec 31, 2025');
  });

  it('returns empty for an absent or invalid instant', () => {
    expect(formatLongDate(null, UTC)).toBe('');
    expect(formatLongDate('', UTC)).toBe('');
    expect(formatLongDate('nope', UTC)).toBe('');
  });
});

describe('formatFullDateTime', () => {
  it('prints the full date and a 24-hour time', () => {
    expect(formatFullDateTime('2026-03-04T10:42:00.000Z', UTC)).toBe('Mar 4, 2026, 10:42');
  });

  it('returns empty for an absent or invalid instant', () => {
    expect(formatFullDateTime(undefined, UTC)).toBe('');
    expect(formatFullDateTime('nope', UTC)).toBe('');
  });

  it('is deterministic when the zone is pinned', () => {
    const iso = '2026-03-04T23:30:00.000Z';
    expect(formatFullDateTime(iso, UTC)).toBe('Mar 4, 2026, 23:30');
    expect(formatFullDateTime(iso, { locale: 'en-US', timeZone: 'Europe/Berlin' })).toBe(
      'Mar 5, 2026, 00:30',
    );
  });
});
