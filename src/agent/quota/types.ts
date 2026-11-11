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

/** Window length by label: a window with no reset stamp is stale once the snapshot is older. */
const WINDOW_LENGTH_MS: Readonly<Record<string, number>> = {
  '5-hour': 5 * 3_600_000,
  '7-day': 7 * 24 * 3_600_000,
};

/**
 * True when the window no longer describes the current period.
 *
 * A window WITH a reset stamp is expired once that instant has passed. A window
 * with no stamp cannot be dated, so it expires by AGE: when the snapshot `readAt`
 * is older than the window length (known labels only). An unknown label, a
 * missing `readAt` or an unparseable instant stays eligible.
 */
export function isWindowExpired(window: QuotaWindow, now: Date, readAt?: string): boolean {
  if (window.resetsAt === null) {
    const length = WINDOW_LENGTH_MS[window.label];
    if (length === undefined || readAt === undefined) return false;
    const read = new Date(readAt).getTime();
    return !Number.isNaN(read) && now.getTime() - read > length;
  }
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
    if (isWindowExpired(w, now, snapshot.readAt)) continue;
    if (best === null || w.usedPct > best.usedPct) best = w;
  }
  return best;
}
