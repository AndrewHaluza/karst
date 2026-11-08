import type { AgentProvider } from '../manifest/types.js';
import { tightestWindow, type QuotaSnapshot, type QuotaWindow } from '../agent/quota/types.js';

/**
 * Pure status-bar builder for the per-core quota summary — the same shape
 * `buildResourceIndicator` uses: the `vscode` binding stays in `extension.ts`.
 *
 * Returns `null` when no core has a readable window — a permanent empty badge
 * is noise on the one surface the user cannot dismiss. The badge shows the
 * tightest window's used-% per core and turns amber at/above the threshold.
 */

export interface QuotaIndicator {
  text: string;
  tooltip: string;
  warning: boolean;
}

interface KnownEntry {
  snapshot: QuotaSnapshot;
  window: QuotaWindow;
}

/**
 * The tooltip shows one line per core with a readable window.
 *
 * `now` drops an already-expired window: a reset window's recorded used-% is
 * stale, so it must neither keep the badge amber nor show a bogus percentage.
 */
export function buildQuotaIndicator(
  snapshots: readonly QuotaSnapshot[],
  thresholdPct: number,
  coreLabel: (core: AgentProvider) => string,
  now: Date,
  accountOf?: (core: AgentProvider) => string | undefined,
): QuotaIndicator | null {
  const known: KnownEntry[] = [];
  for (const snapshot of snapshots) {
    const window = tightestWindow(snapshot, now);
    if (window) known.push({ snapshot, window });
  }
  if (known.length === 0) return null;

  // The account name rides beside the core when the active account is not 'default'.
  const named = (core: AgentProvider): string => {
    const account = accountOf?.(core);
    return account ? `${coreLabel(core)} (${account})` : coreLabel(core);
  };
  const segments = known.map(
    ({ snapshot, window }) => `${named(snapshot.core)} ${Math.round(window.usedPct)}%`,
  );
  const warning = known.some(({ window }) => window.usedPct >= thresholdPct);
  const tooltip = known
    .map(({ snapshot, window }) => {
      const reset = window.resetsAt ? ` · resets ${window.resetsAt}` : '';
      return `${named(snapshot.core)}: ${Math.round(window.usedPct)}% of ${window.label}${reset}`;
    })
    .concat(`Warn threshold ${thresholdPct}%`)
    .join('\n');

  return {
    text: `$(dashboard) ${segments.join(' · ')}`,
    tooltip,
    warning,
  };
}
