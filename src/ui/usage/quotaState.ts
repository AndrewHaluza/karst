import type { AgentProvider } from '../../manifest/types.js';
import { tightestUsedPct, type QuotaSnapshot } from '../../agent/quota/types.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentProviders.js';

/**
 * The Quota tab's read model.
 *
 * Every string is formatted HERE, host-side, for the same reason the spend tab
 * formats host-side: the webview cannot import a formatter, so anything it
 * formats itself is a second implementation of the rule (UI-R31). The webview
 * receives strings and widths and renders them.
 *
 * A core with no readable source renders `unknown` with its reason — never a
 * fabricated 0% (`arch:AC-29`).
 */

/** The state band of one window, compared against the warn threshold. */
export type QuotaLevel = 'ok' | 'near' | 'exhausted';

export interface QuotaWindowView {
  label: string;
  /** Rounded used-%, 0–100. */
  usedPct: number;
  level: QuotaLevel;
  /** Bar width as a percentage string, e.g. `76`. */
  width: string;
  /** ISO-8601 reset instant, or null. */
  resetsAt: string | null;
  /** Human countdown to `resetsAt`, e.g. `2h 13m`, or null. */
  resetsIn: string | null;
}

export interface QuotaRowView {
  core: AgentProvider;
  /** Display label for the core (registry-derived). */
  label: string;
  state: 'ok' | 'unknown';
  windows: QuotaWindowView[];
  /** Provenance, e.g. `Codex session rate limits`; null when unknown. */
  source: string | null;
  /** `3m ago` for the last read; null when unknown. */
  readAgo: string | null;
  /** Why the core is unknown; null when it was read. */
  reason: string | null;
}

export interface QuotaView {
  thresholdPct: number;
  rows: QuotaRowView[];
  /** True when any known core's tightest window is at/above the threshold. */
  anyNear: boolean;
}

/** `just now` / `3m ago` / `2h ago` / `4d ago`. Never a negative age. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `2h 13m` / `13m` / `45s`; `resetting now` once the instant has passed. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'resetting now';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function levelFor(usedPct: number, thresholdPct: number): QuotaLevel {
  if (usedPct >= 100) return 'exhausted';
  return usedPct >= thresholdPct ? 'near' : 'ok';
}

function windowView(
  label: string,
  usedPct: number,
  resetsAt: string | null,
  thresholdPct: number,
  now: Date,
): QuotaWindowView {
  const clamped = Math.max(0, Math.min(100, usedPct));
  let resetsIn: string | null = null;
  if (resetsAt !== null) {
    const at = new Date(resetsAt).getTime();
    if (!Number.isNaN(at)) resetsIn = formatCountdown(at - now.getTime());
  }
  return {
    label,
    usedPct: Math.round(clamped),
    level: levelFor(clamped, thresholdPct),
    width: String(Math.round(clamped)),
    resetsAt,
    resetsIn,
  };
}

function rowView(snapshot: QuotaSnapshot, thresholdPct: number, now: Date): QuotaRowView {
  const label = AGENT_PROVIDER_LABELS[snapshot.core] ?? snapshot.core;
  if (snapshot.state !== 'ok') {
    return {
      core: snapshot.core,
      label,
      state: 'unknown',
      windows: [],
      source: null,
      readAgo: null,
      reason: snapshot.reason,
    };
  }
  const readAt = new Date(snapshot.readAt).getTime();
  return {
    core: snapshot.core,
    label,
    state: 'ok',
    windows: snapshot.windows.map((w) =>
      windowView(w.label, w.usedPct, w.resetsAt, thresholdPct, now),
    ),
    source: snapshot.source,
    readAgo: Number.isNaN(readAt) ? null : formatAge(now.getTime() - readAt),
    reason: null,
  };
}

/** Build the Quota tab from the service's snapshots, threshold and clock. */
export function buildQuotaView(
  snapshots: readonly QuotaSnapshot[],
  thresholdPct: number,
  now: Date,
): QuotaView {
  const rows = snapshots.map((snapshot) => rowView(snapshot, thresholdPct, now));
  const anyNear = snapshots.some((snapshot) => {
    const tightest = tightestUsedPct(snapshot, now);
    return tightest !== null && tightest >= thresholdPct;
  });
  return { thresholdPct, rows, anyNear };
}
