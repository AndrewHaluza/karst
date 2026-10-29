import { tightestWindow, type QuotaSnapshot } from './types.js';

/**
 * The launch/spin warning decision, kept host-agnostic and pure so the exact
 * sentence is testable without a `vscode` binding.
 *
 * View-only by design (D163): a core at or above the threshold produces a
 * NON-BLOCKING warning — the caller may proceed, and karst never switches
 * cores. An unknown core never warns (there is nothing measured to warn about).
 */

/**
 * Format remaining milliseconds as a human-friendly duration:
 * '< 1m', '45m', '5h 30m', '1d 6h'.
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '< 1m';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format a reset instant in the operator's local timezone:
 * short month, day, 2-digit hour & minute (e.g. 'Oct 30, 19:00').
 */
export function formatResetDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/**
 * The warning notification for a core at/above the threshold, or null.
 *
 * `now` excludes an already-expired window: the provider's recorded used-%
 * describes a period that has reset, so it must not warn until a fresh read.
 */
export function quotaLaunchWarning(
  snapshot: QuotaSnapshot | undefined,
  thresholdPct: number,
  coreLabel: string,
  now: Date,
): string | null {
  if (!snapshot) return null;
  const tightest = tightestWindow(snapshot, now);
  if (!tightest || tightest.usedPct < thresholdPct) return null;

  const line1 = `${coreLabel} is at ${Math.round(tightest.usedPct)}% of ${tightest.label} quota (threshold ${thresholdPct}%).`;

  let line2 = 'Karst will not block.';
  if (tightest.resetsAt !== null) {
    const at = new Date(tightest.resetsAt).getTime();
    if (!Number.isNaN(at)) {
      const duration = formatDuration(at - now.getTime());
      const localDate = formatResetDate(new Date(at));
      line2 = `Resets in ${duration} (${localDate}) · Karst will not block.`;
    }
  }

  return `${line1}\n${line2}`;
}

