/**
 * Display strings for token counts (§ token consumption stats).
 *
 * Host-side, like every other renderer in `model/` and for the same reason: a
 * webview cannot import a formatter, so a number formatted in the webview is a
 * second implementation that will drift from this one. The stats view renders
 * only what it is pushed.
 *
 * Counts here run from single digits to tens of millions in the same column, so
 * the display is abbreviated (`1.2M`) while the exact value stays available as a
 * grouped string for the title attribute — an abbreviation is for scanning, and
 * "did this ticket cost 1.2M or 1.24M" is a question the exact value answers.
 */

/** `1234567` → `1.2M`. Never rounds a non-zero count to `0`. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  if (count < 1_000) return String(Math.round(count));
  if (count < 1_000_000) return `${trim(count / 1_000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

/** One decimal, but never a trailing `.0` — `1.0k` reads as false precision. */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** `1234567` → `1,234,567`. The exact value, for a tooltip. */
export function formatExactTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  return Math.round(count).toLocaleString('en-US');
}

/**
 * A group's share of the total, 0–100, rounded to one decimal. Zero total is 0,
 * not NaN — an empty range renders as bars of nothing, not as a broken layout.
 */
export function shareOfTotal(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}
