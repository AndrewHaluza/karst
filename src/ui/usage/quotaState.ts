import type { AgentProvider } from '../../manifest/types.js';
import {
  isWindowExpired,
  tightestUsedPct,
  tightestWindow,
  type QuotaSnapshot,
  type QuotaWindow,
} from '../../agent/quota/types.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentProviders.js';
import {
  formatAge,
  formatCountdown,
  quotaCoreLabel,
  quotaWarnThresholdText,
  quotaWindowMeta,
  quotaWindowPct,
  QUOTA_EXPIRED_TEXT,
  type QuotaLevel,
} from '../../model/quotaText.js';

/**
 * The Quota tab's read model.
 *
 * Every string is formatted HERE, host-side, for the same reason the spend tab
 * formats host-side: the webview cannot import a formatter, so anything it
 * formats itself is a second implementation of the rule (UI-R31). The webview
 * receives strings and widths and renders them.
 *
 * A core with no readable source renders `unknown` with its reason — never a
 * fabricated 0% (`arch:AC-48`).
 */

export type { QuotaLevel };

/** A read older than this is called out as possibly out of date (US-31). */
export const QUOTA_STALE_MS = 60 * 60 * 1000;

export interface QuotaWindowView {
  label: string;
  /** Rounded used-%, 0–100. */
  usedPct: number;
  level: QuotaLevel;
  /** Bar width as a percentage string, e.g. `76`; `0` for an expired window. */
  width: string;
  /** ISO-8601 reset instant, or null. */
  resetsAt: string | null;
  /** Human countdown to `resetsAt`, e.g. `2h 13m`, or null. */
  resetsIn: string | null;
  /** True when the reset instant already passed (US-3). */
  expired: boolean;
  /** `Resets in 2h 13m`, `No reset time reported`, or `Reset · waiting for a new read`. */
  meta: string;
  /** `Near limit` / `Limit reached`, or null for ok and expired windows (US-19). */
  levelLabel: string | null;
  /** `82% used`, or null when the window is expired and the percent is stale (US-3). */
  usedDisplay: string | null;
  /** `Codex 7-day used` — the meter's accessible name (US-26). */
  ariaLabel: string;
}

/** The active account name of a core when it is not 'default'; shown beside the core label. */
export type AccountOf = (core: AgentProvider) => string | undefined;

export interface QuotaRowView {
  core: AgentProvider;
  /** Display label for the core (registry-derived, with the account when active). */
  label: string;
  state: 'ok' | 'unknown';
  windows: QuotaWindowView[];
  /** Provenance, e.g. `Codex session rate limits`; null when unknown. */
  source: string | null;
  /** `3m ago` for the last read; null when unknown. */
  readAgo: string | null;
  /** `Read 3m ago`, or `Read 4d ago · may be out of date` when stale (US-31). */
  readMeta: string | null;
  /** True when the cached read is older than `QUOTA_STALE_MS` (US-31). */
  stale: boolean;
  /** Why the core is unknown (raw technical text, for the tooltip); null when read. */
  reason: string | null;
  /** A plain human sentence for an unknown core, never a raw path (US-32). */
  plainReason: string | null;
}

export interface QuotaView {
  thresholdPct: number;
  rows: QuotaRowView[];
  /** True when any known core's tightest open window is at/above the threshold. */
  anyNear: boolean;
  /** `Warn at 80% used` — the tab's subtitle (US-30). */
  subtitle: string;
  /** `Codex 7-day is at 82% used.` — the tab's one summary line (US-19). */
  summaryLine: string | null;
}

function levelFor(usedPct: number, thresholdPct: number): QuotaLevel {
  if (usedPct >= 100) return 'exhausted';
  return usedPct >= thresholdPct ? 'near' : 'ok';
}

function levelLabelFor(level: QuotaLevel, expired: boolean): string | null {
  if (expired) return null;
  if (level === 'near') return 'Near limit';
  if (level === 'exhausted') return 'Limit reached';
  return null;
}

function windowView(
  rowLabel: string,
  window: QuotaWindow,
  thresholdPct: number,
  now: Date,
  readAt: string,
): QuotaWindowView {
  const clamped = Math.max(0, Math.min(100, window.usedPct));
  const usedPct = Math.round(clamped);
  const expired = isWindowExpired(window, now, readAt);
  const resetsHref = window.resetsAt;
  const at = resetsHref === null ? NaN : new Date(resetsHref).getTime();
  const level = expired ? 'ok' : levelFor(clamped, thresholdPct);

  return {
    label: window.label,
    usedPct,
    level,
    width: expired ? '0' : String(usedPct),
    resetsAt: resetsHref,
    resetsIn: expired || Number.isNaN(at) ? null : formatCountdown(at - now.getTime()),
    expired,
    meta: quotaWindowMeta(window, now, readAt),
    levelLabel: levelLabelFor(level, expired),
    usedDisplay: expired ? null : quotaWindowPct(usedPct),
    ariaLabel: `${rowLabel} ${window.label} used`,
  };
}

/**
 * The plain sentence an unknown core shows (US-32): the technical reason (a
 * cache path, an HTTP status) stays in the tooltip, never in the body copy.
 */
function plainReasonFor(core: AgentProvider, reason: string | null): string {
  const text = (reason ?? '').toLowerCase();
  if (core === 'claude') {
    if (/429|rate.?limit/.test(text)) return 'Claude Code quota API is temporarily rate limited.';
    if (/401|token|expired|sign|oauth|credential/.test(text)) {
      return 'Claude Code needs a valid sign-in to read quota.';
    }
    if (/file|cache|quota\.json|not found|enoent/.test(text)) {
      return 'Claude Code has not written a quota file yet.';
    }
    return 'Claude Code quota is not available right now.';
  }
  if (core === 'codex') {
    if (/session|file/.test(text)) return 'Codex has not recorded a session yet.';
    return 'Codex quota is not available right now.';
  }
  if (core === 'antigravity') {
    return 'Antigravity CLI does not expose quota locally.';
  }
  if (core === 'opencode' || core === 'opencode2') {
    if (/go plan/.test(text)) return 'This OpenCode account does not have a Go plan.';
    return 'OpenCode quota is not available right now.';
  }
  return 'Quota is not available right now.';
}

function rowView(snapshot: QuotaSnapshot, thresholdPct: number, now: Date, accountOf?: AccountOf): QuotaRowView {
  const account = accountOf?.(snapshot.core);
  const coreLabel = AGENT_PROVIDER_LABELS[snapshot.core] ?? snapshot.core;
  const label = quotaCoreLabel(coreLabel, account);
  if (snapshot.state !== 'ok') {
    return {
      core: snapshot.core,
      label,
      state: 'unknown',
      windows: [],
      source: null,
      readAgo: null,
      readMeta: null,
      stale: false,
      reason: snapshot.reason,
      plainReason: plainReasonFor(snapshot.core, snapshot.reason),
    };
  }
  const readAt = new Date(snapshot.readAt).getTime();
  const age = Number.isNaN(readAt) ? null : now.getTime() - readAt;
  const stale = age !== null && age > QUOTA_STALE_MS;
  const readAgo = age === null ? null : formatAge(age);
  return {
    core: snapshot.core,
    label,
    state: 'ok',
    // The T1300 rule (never a stale "resetting now" bar) holds per window: an
    // expired window keeps its label but loses its percent, countdown and bar
    // fill. D751 keeps the window VISIBLE with `QUOTA_EXPIRED_TEXT` instead of
    // filtering it out (hiding it leaves the user unable to see why a core has
    // no number), and `anyNear` already skips every expired window below.
    windows: snapshot.windows.map((w) => windowView(label, w, thresholdPct, now, snapshot.readAt)),
    source: snapshot.source,
    readAgo,
    readMeta: readAgo === null ? null : stale ? `Read ${readAgo} · may be out of date` : `Read ${readAgo}`,
    stale,
    reason: null,
    plainReason: null,
  };
}

/**
 * The tightest open window at/above the threshold, as one sentence (US-19).
 *
 * The sentence names the SAME window `anyNear` is about (`tightestWindow`): a
 * primary window wins over a `secondary` side pool, so an exhausted model pool
 * never hijacks the banner while primary subscription capacity still has room.
 */
function summaryLineFor(
  snapshots: readonly QuotaSnapshot[],
  rows: readonly QuotaRowView[],
  thresholdPct: number,
  now: Date,
): string | null {
  let best: { row: QuotaRowView; windowLabel: string; usedPct: number } | null = null;
  for (let i = 0; i < snapshots.length; i += 1) {
    const window = tightestWindow(snapshots[i]!, now);
    if (window === null) continue;
    const usedPct = Math.round(Math.max(0, Math.min(100, window.usedPct)));
    if (usedPct < thresholdPct) continue;
    if (best === null || usedPct > best.usedPct) {
      best = { row: rows[i]!, windowLabel: window.label, usedPct };
    }
  }
  return best === null
    ? null
    : `${best.row.label} ${best.windowLabel} is at ${best.usedPct}% used.`;
}

/** Build the Quota tab from the service's snapshots, threshold and clock. */
export function buildQuotaView(
  snapshots: readonly QuotaSnapshot[],
  thresholdPct: number,
  now: Date,
  accountOf?: AccountOf,
): QuotaView {
  const rows = snapshots.map((snapshot) => rowView(snapshot, thresholdPct, now, accountOf));
  const anyNear = snapshots.some((snapshot) => {
    const tightest = tightestUsedPct(snapshot, now);
    return tightest !== null && tightest >= thresholdPct;
  });
  return {
    thresholdPct,
    rows,
    anyNear,
    subtitle: quotaWarnThresholdText(thresholdPct),
    summaryLine: anyNear ? summaryLineFor(snapshots, rows, thresholdPct, now) : null,
  };
}
