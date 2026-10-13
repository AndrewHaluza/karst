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

/** The tooltip shows one line per core with a readable window. */
export function buildQuotaIndicator(
  snapshots: readonly QuotaSnapshot[],
  thresholdPct: number,
  coreLabel: (core: AgentProvider) => string,
): QuotaIndicator | null {
  const known: KnownEntry[] = [];
  for (const snapshot of snapshots) {
    const window = tightestWindow(snapshot);
    if (window) known.push({ snapshot, window });
  }
  if (known.length === 0) return null;

  const segments = known.map(
    ({ snapshot, window }) => `${coreLabel(snapshot.core)} ${Math.round(window.usedPct)}%`,
  );
  const warning = known.some(({ window }) => window.usedPct >= thresholdPct);
  const tooltip = known
    .map(({ snapshot, window }) => {
      const reset = window.resetsAt ? ` · resets ${window.resetsAt}` : '';
      return `${coreLabel(snapshot.core)}: ${Math.round(window.usedPct)}% of ${window.label}${reset}`;
    })
    .concat(`Warn threshold ${thresholdPct}%`)
    .join('\n');

  return {
    text: `$(dashboard) ${segments.join(' · ')}`,
    tooltip,
    warning,
  };
}
