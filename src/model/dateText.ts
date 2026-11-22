/**
 * Calendar-date display strings for the token-usage view (US-1, US-16).
 *
 * Kept separate from `formatPrStamp` and the sidebar's `dayLabel`: those answer
 * "when did this run" for a different surface with different buckets, and one
 * shared formatter would make every future tweak a cross-screen negotiation.
 *
 * Locale rule (US-17): the default is the VIEWER's locale and time zone
 * (`undefined` → the runtime's own). A fixture or a unit test that needs the
 * same string on every machine passes `{ locale: 'en-US', timeZone: 'UTC' }`.
 *
 * The "today" branch is a calendar comparison in the chosen zone, never a
 * 24-hour subtraction: an instant at 23:50 and one at 00:10 are different days
 * even though they are twenty minutes apart.
 */

export interface DateTextOptions {
  /** BCP-47 tag; `undefined` = the viewer's locale. */
  locale?: string;
  /** IANA zone; `undefined` = the viewer's local time zone. */
  timeZone?: string;
}

/** A valid `Date`, or null for null/undefined/empty/invalid input. */
function instant(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined) return null;
  const text = iso.trim();
  if (text === '') return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** The year/month/day an instant falls on, in the chosen zone. */
function calendarDay(at: Date, timeZone: string | undefined): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(at);
  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '');
  return { year: value('year'), month: value('month'), day: value('day') };
}

/**
 * `10:42` for today, `Mar 4` earlier this year, `Mar 4, 2025` for another year.
 * Empty for an unparseable instant or an invalid `now`.
 */
export function formatCalendarDate(
  iso: string | null | undefined,
  now: Date,
  options: DateTextOptions = {},
): string {
  const at = instant(iso);
  if (at === null || Number.isNaN(now.getTime())) return '';
  const day = calendarDay(at, options.timeZone);
  const today = calendarDay(now, options.timeZone);
  if (day.year === today.year && day.month === today.month && day.day === today.day) {
    return new Intl.DateTimeFormat(options.locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: options.timeZone,
    }).format(at);
  }
  if (day.year === today.year) {
    return new Intl.DateTimeFormat(options.locale, {
      month: 'short',
      day: 'numeric',
      timeZone: options.timeZone,
    }).format(at);
  }
  return new Intl.DateTimeFormat(options.locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: options.timeZone,
  }).format(at);
}

/** `Mar 4, 2026` — the year is always present. Empty for an invalid instant. */
export function formatLongDate(
  iso: string | null | undefined,
  options: DateTextOptions = {},
): string {
  const at = instant(iso);
  if (at === null) return '';
  return new Intl.DateTimeFormat(options.locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: options.timeZone,
  }).format(at);
}

/**
 * `Mar 4, 2026, 10:42` — a full date and time for a tooltip. Empty for an
 * invalid instant.
 */
export function formatFullDateTime(
  iso: string | null | undefined,
  options: DateTextOptions = {},
): string {
  const at = instant(iso);
  if (at === null) return '';
  return new Intl.DateTimeFormat(options.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: options.timeZone,
  }).format(at);
}
