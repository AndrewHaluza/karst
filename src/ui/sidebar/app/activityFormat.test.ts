import { describe, expect, it } from 'vitest';
import type { ActivityRowView } from '../activity.js';
import { activityCount, dayLabel, groupByDay, matchesLevel, timeText } from './activityFormat.js';

const at = (y: number, mo: number, d: number, h = 12, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();
const row = (id: number, ms: number, level: ActivityRowView['level'] = 'info'): ActivityRowView => ({
  id, level, title: `t${id}`, ticketId: null, ticketLabel: null, createdAt: iso(ms), unread: true,
});

describe('activity format', () => {
  const now = at(2026, 11, 19, 15, 0);
  it('names today and yesterday and prints an older date', () => {
    expect(dayLabel(iso(at(2026, 11, 19, 0, 5)), now)).toBe('Today');
    expect(dayLabel(iso(at(2026, 11, 18, 23, 59)), now)).toBe('Yesterday');
    const older = dayLabel(iso(at(2026, 11, 3)), now);
    expect(older).not.toBe('Today');
    expect(older).not.toBe('Yesterday');
    expect(older).toMatch(/3/);
  });
  it('returns empty text for a bad time', () => {
    expect(dayLabel('nope', now)).toBe('');
    expect(timeText('nope')).toBe('');
  });
  it('prints the local time as HH:MM', () => {
    expect(timeText(iso(at(2026, 11, 19, 8, 5)))).toBe('08:05');
    expect(timeText(iso(at(2026, 11, 19, 23, 40)))).toBe('23:40');
  });
  it('groups consecutive rows by day and keeps the order', () => {
    const groups = groupByDay([row(5, at(2026, 11, 19, 14)), row(4, at(2026, 11, 19, 9)), row(3, at(2026, 11, 18, 20)), row(2, at(2026, 11, 3))], now);
    expect(groups.map((g) => [g.label === 'Today' || g.label === 'Yesterday' ? g.label : 'date', g.rows.map((r) => r.id)])).toEqual([
      ['Today', [5, 4]], ['Yesterday', [3]], ['date', [2]],
    ]);
  });
  it('the problems filter keeps errors and warnings', () => {
    expect(matchesLevel(row(1, now, 'error'), 'problems')).toBe(true);
    expect(matchesLevel(row(1, now, 'warn'), 'problems')).toBe(true);
    expect(matchesLevel(row(1, now, 'success'), 'problems')).toBe(false);
    expect(matchesLevel(row(1, now, 'info'), 'problems')).toBe(false);
    expect(matchesLevel(row(1, now, 'info'), 'all')).toBe(true);
  });
  it('counts new rows first, else the total', () => {
    expect(activityCount(3, 10)).toBe('3 new');
    expect(activityCount(0, 10)).toBe('10');
    expect(activityCount(0, 0)).toBe('0');
  });
});
