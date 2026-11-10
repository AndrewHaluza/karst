/** Coarse relative ages, shared by the PR panel and the merge-readiness model. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Age in coarse buckets — the dashboard's ONE relative-age vocabulary, shared by
 * the PR stamps and the merge-verdict lines (buildMergeCheckPanelRows).
 *
 * Deliberately coarser than `formatDuration`: the label only refreshes when the
 * host pushes state, so `4m 12s ago` would claim a precision the value does not
 * have. An unreadable stamp, or one in the future (clock skew), yields '' — the
 * row states no age rather than a wrong one.
 */
export function formatAge(at: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}
