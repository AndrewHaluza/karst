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
   * Read the core's quota now. Local reads only — never a model request.
   * Async: a reader runs on the extension host's event loop, so it must never
   * use synchronous file I/O.
   */
  read(): Promise<QuotaSnapshot>;
}

/** The used-% of a core's TIGHTEST (highest-usage) window, or null when unknown. */
export function tightestUsedPct(snapshot: QuotaSnapshot): number | null {
  return tightestWindow(snapshot)?.usedPct ?? null;
}

/** The window with the highest used-% — the one a warning is about. */
export function tightestWindow(snapshot: QuotaSnapshot): QuotaWindow | null {
  if (snapshot.state !== 'ok' || snapshot.windows.length === 0) return null;
  let best = snapshot.windows[0]!;
  for (const w of snapshot.windows) if (w.usedPct > best.usedPct) best = w;
  return best;
}
