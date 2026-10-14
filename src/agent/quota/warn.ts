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
 * The warning sentence for a core at/above the threshold, or null.
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
  const reset = tightest.resetsAt ? ` Resets at ${tightest.resetsAt}.` : '';
  return (
    `${coreLabel} is at ${Math.round(tightest.usedPct)}% of its ${tightest.label} subscription window ` +
    `(warn threshold ${thresholdPct}%).${reset} You can continue — Karst will not block or switch cores.`
  );
}
