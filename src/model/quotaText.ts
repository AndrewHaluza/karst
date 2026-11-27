import type { QuotaWindow } from '../agent/quota/types.js';

/**
 * The one wording for subscription quota, shared by the Quota tab and the
 * status-bar tooltip (US-3, US-28, US-30).
 *
 * The two surfaces used to disagree about an expired window: the tab kept a
 * stale percentage while the badge silently dropped the core. One constant and
 * one tooltip builder is what makes them say the same sentence.
 *
 * Layer note: `src/model/**` may not value-import `src/agent/**`
 * (`core-agent-seam` in `.dependency-cruiser.cjs`), so the expiry rule below is
 * a local copy of `isWindowExpired` (`agent/quota/types.ts`). A parity test in
 * `quotaText.test.ts` drives both over the same table, so they cannot drift.
 */

/** The one text for a window whose reset instant has passed (US-3). */
export const QUOTA_EXPIRED_TEXT = 'Reset · waiting for a new read';

/** The state band of one window, compared against the warn threshold (US-29). */
export type QuotaLevel = 'ok' | 'near' | 'exhausted';

/** `just now` / `3m ago` / `2h ago` / `4d ago`. Never a negative age. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * `2h 13m` / `13m` / `45s`. Null once the instant has passed — the caller
 * decides how to word an expired window (US-3), and `'resetting now'` was that
 * decision leaking into the formatter.
 */
export function formatCountdown(ms: number): string | null {
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Window length by label: a window with no reset stamp is stale once the snapshot is older. */
const WINDOW_LENGTH_MS: Readonly<Record<string, number>> = {
  '5-hour': 5 * 3_600_000,
  '7-day': 7 * 24 * 3_600_000,
};

/** Local copy of `isWindowExpired`; parity-pinned by `quotaText.test.ts`. */
function windowExpired(window: QuotaWindow, now: Date, readAt?: string): boolean {
  if (window.resetsAt === null) {
    const length = WINDOW_LENGTH_MS[window.label];
    if (length === undefined || readAt === undefined) return false;
    const read = new Date(readAt).getTime();
    return !Number.isNaN(read) && now.getTime() - read > length;
  }
  const at = new Date(window.resetsAt).getTime();
  return !Number.isNaN(at) && at <= now.getTime();
}

/**
 * What sits beside a window's used-%: its countdown, why there is none, or the
 * one expired sentence. The expiry rule is `isWindowExpired`'s (see the layer
 * note above), so a window cannot be open on one surface and expired on the
 * other.
 */
export function quotaWindowMeta(window: QuotaWindow, now: Date, readAt?: string): string {
  if (windowExpired(window, now, readAt)) return QUOTA_EXPIRED_TEXT;
  if (window.resetsAt === null) return 'No reset time reported';
  const at = new Date(window.resetsAt).getTime();
  if (Number.isNaN(at)) return 'No reset time reported';
  const countdown = formatCountdown(at - now.getTime());
  return countdown === null ? QUOTA_EXPIRED_TEXT : `Resets in ${countdown}`;
}

/** `Claude Code · work` when an account is active, else the core label (US-30). */
export function quotaCoreLabel(coreLabel: string, account?: string): string {
  return account ? `${coreLabel} · ${account}` : coreLabel;
}

/** `34% used` — the percentage alone, for a window card (US-30). */
export function quotaWindowPct(usedPct: number): string {
  return `${Math.round(usedPct)}% used`;
}

/** `5-hour: 34% used` — the window and its percentage, for a tooltip line. */
export function quotaWindowSummary(windowLabel: string, usedPct: number): string {
  return `${windowLabel}: ${Math.round(usedPct)}% used`;
}

/** `Warn at 80% used` — the tooltip's threshold footer (US-30). */
export function quotaWarnThresholdText(thresholdPct: number): string {
  return `Warn at ${thresholdPct}% used`;
}

/** `Codex: Reset · waiting for a new read` — an all-expired core (US-3). */
export function quotaExpiredTooltipLine(coreDisplay: string): string {
  return `${coreDisplay}: ${QUOTA_EXPIRED_TEXT}`;
}

/**
 * `Codex: 5-hour: 34% used · Resets in 2h 13m` — one open window's tooltip
 * line, identical on the Quota tab and in the status bar (US-28).
 */
export function quotaWindowTooltipLine(
  coreDisplay: string,
  window: QuotaWindow,
  now: Date,
  readAt?: string,
): string {
  return `${coreDisplay}: ${quotaWindowSummary(window.label, window.usedPct)} · ${quotaWindowMeta(window, now, readAt)}`;
}

/**
 * The session's own quota line for a direct ssh ticket (`@arch:AC-29`, D826):
 * `claude ssh · devbox quota: unknown (remote login)`. The host quota probe
 * reads THIS Mac's login, so it cannot describe the login on the remote; the
 * host account's numbers are never shown for the session.
 */
export function sessionQuotaLine(core: string, remote: string): string {
  return `${core} ssh · ${remote} quota: unknown (remote login)`;
}
