import type { AgentProvider } from '../../manifest/types.js';

/**
 * Provider-reported SUBSCRIPTION quota, one snapshot per agent core.
 *
 * The source of truth is the provider, never karst's own token ledger
 * (`agent/tokenUsage.ts`): a self-estimate ignores usage outside karst and
 * would read a core as fresh while the account is nearly exhausted. A core with
 * no readable source is a legitimate `unknown` (the `arch:AC-05` spirit) — it
 * renders as unknown, never as 0%.
 *
 * Secrets are NEVER carried here: a reader parses the provider's response for
 * the window numbers and drops the token that authorized it. Nothing in this
 * module is persisted or logged.
 */

/** One subscription window: a used-% with the instant it resets. */
export interface QuotaWindow {
  /** Host-resolved label, e.g. `5-hour`, `7-day`. */
  label: string;
  /** 0–100, provider-reported. */
  usedPct: number;
  /** ISO-8601 instant the window resets, or null when the provider gave none. */
  resetsAt: string | null;
}

/** A core whose quota was read: at least one window, plus provenance. */
export interface QuotaKnown {
  core: AgentProvider;
  state: 'ok';
  windows: QuotaWindow[];
  /** Where the numbers came from, e.g. `Codex session rate limits`. */
  source: string;
  /** ISO-8601 instant the snapshot was read. */
  readAt: string;
}

/** A core with no readable source (or a read that failed). Never a fake 0%. */
export interface QuotaUnknown {
  core: AgentProvider;
  state: 'unknown';
  reason: string;
}

export type QuotaSnapshot = QuotaKnown | QuotaUnknown;

/** One core's reader behind a common interface. */
export interface QuotaReader {
  core: AgentProvider;
  /**
   * Read the core's quota now. Local reads, or a provider usage API that spends
   * no model request. Async: a reader runs on the extension host's event loop,
   * so it must never use synchronous file I/O.
   */
  read(): Promise<QuotaSnapshot>;
}

/**
 * True when a window's reset instant has already passed: the window has reset,
 * so its recorded used-% describes a period that no longer applies. A window
 * with no reset stamp (or an unparseable one) cannot be shown to have expired,
 * so it stays eligible — only a definite past instant excludes a window.
 */
export function isWindowExpired(window: QuotaWindow, now: Date): boolean {
  if (window.resetsAt === null) return false;
  const at = new Date(window.resetsAt).getTime();
  return !Number.isNaN(at) && at <= now.getTime();
}

/** The used-% of a core's TIGHTEST still-open window, or null when unknown. */
export function tightestUsedPct(snapshot: QuotaSnapshot, now: Date): number | null {
  return tightestWindow(snapshot, now)?.usedPct ?? null;
}

/**
 * The still-open window with the highest used-% — the one a warning is about.
 *
 * An EXPIRED window is skipped: its reset already passed, so the provider's
 * recorded used-% is stale and must not keep the badge amber or the launch
 * warning firing until a new session refreshes the read. Null when the core is
 * unknown or every window has expired.
 */
export function tightestWindow(snapshot: QuotaSnapshot, now: Date): QuotaWindow | null {
  if (snapshot.state !== 'ok') return null;
  let best: QuotaWindow | null = null;
  for (const w of snapshot.windows) {
    if (isWindowExpired(w, now)) continue;
    if (best === null || w.usedPct > best.usedPct) best = w;
  }
  return best;
}
