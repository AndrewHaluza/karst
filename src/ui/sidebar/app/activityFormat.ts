/**
 * Pure helpers of the Activity pane: the day groups and the local time. The host sends UTC ISO
 * times; the webview formats them in the viewer's zone and clock, as `relTime` does.
 */
import type { ActivityRowView } from '../activity.js';

export type ActivityLevelFilter = 'all' | 'problems';

export const ACTIVITY_LEVEL_WORD: Readonly<Record<ActivityRowView['level'], string>> = {
  error: 'Error',
  warn: 'Warning',
  success: 'Done',
  info: 'Info',
};

export const ACTIVITY_EMPTY_TEXT = 'No activity yet.';
export const ACTIVITY_NO_MATCH_TEXT = 'No rows match the filter.';

export interface ActivityGroup {
  readonly label: string;
  readonly rows: readonly ActivityRowView[];
}

const dayKey = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 'Today', 'Yesterday', else the local date (`Mon 3 Nov`); empty for a time that does not parse. */
export function dayLabel(iso: string, now: number): string {
  const t = new Date(Date.parse(iso));
  if (Number.isNaN(t.getTime())) return '';
  const diff = Math.round((dayKey(new Date(now)) - dayKey(t)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Local `HH:MM`, 24 hours; empty for a time that does not parse. */
export function timeText(iso: string): string {
  const t = new Date(Date.parse(iso));
  if (Number.isNaN(t.getTime())) return '';
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

export function matchesLevel(row: ActivityRowView, filter: ActivityLevelFilter): boolean {
  return filter === 'all' || row.level === 'error' || row.level === 'warn';
}

/** Rows (newest first) in consecutive groups of one day each, order kept. */
export function groupByDay(rows: readonly ActivityRowView[], now: number): ActivityGroup[] {
  const groups: { label: string; rows: ActivityRowView[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(row.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** The header count while unfiltered: `6 · 2 new` once anything is unread, else the total (SB-17). */
export function activityCount(unread: number, total: number): string {
  return unread > 0 ? `${total} · ${unread} new` : String(total);
}
