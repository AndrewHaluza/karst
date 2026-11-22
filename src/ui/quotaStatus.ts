import type { AgentProvider } from '../manifest/types.js';
import {
  tightestWindow,
  type QuotaKnown,
  type QuotaSnapshot,
  type QuotaWindow,
} from '../agent/quota/types.js';
import {
  quotaCoreLabel,
  quotaExpiredTooltipLine,
  quotaWarnThresholdText,
  quotaWindowTooltipLine,
  type QuotaLevel,
} from '../model/quotaText.js';

/**
 * Pure status-bar builder for the per-core quota summary — the same shape
 * `buildResourceIndicator` uses: the `vscode` binding stays in `extension.ts`.
 *
 * Returns `null` when no core has a readable OPEN window — a permanent empty
 * badge is noise on the one surface the user cannot dismiss. The badge shows the
 * tightest open window's used-% per core and carries a three-way level so the
 * binding can paint it green/amber/red (US-29).
 *
 * An expired window is not shown as a percentage (it would be stale); a core
 * whose EVERY window has expired still gets one tooltip line saying so, the same
 * sentence the Quota tab renders (US-3).
 */

export interface QuotaIndicator {
  text: string;
  tooltip: string;
  level: QuotaLevel;
}

interface KnownEntry {
  snapshot: QuotaKnown;
  window: QuotaWindow;
}

/** The strongest level across the open windows (US-29). */
function levelOf(open: readonly KnownEntry[], thresholdPct: number): QuotaLevel {
  if (open.some(({ window }) => window.usedPct >= 100)) return 'exhausted';
  if (open.some(({ window }) => window.usedPct >= thresholdPct)) return 'near';
  return 'ok';
}

/** The glyph that carries the level before the text. */
function glyphFor(level: QuotaLevel): string {
  if (level === 'exhausted') return '$(error)';
  return level === 'near' ? '$(warning)' : '$(dashboard)';
}

export function buildQuotaIndicator(
  snapshots: readonly QuotaSnapshot[],
  thresholdPct: number,
  coreLabel: (core: AgentProvider) => string,
  now: Date,
  accountOf?: (core: AgentProvider) => string | undefined,
): QuotaIndicator | null {
  const open: KnownEntry[] = [];
  const expired: QuotaSnapshot[] = [];
  for (const snapshot of snapshots) {
    const window = tightestWindow(snapshot, now);
    if (window !== null && snapshot.state === 'ok') {
      open.push({ snapshot, window });
      continue;
    }
    if (snapshot.state === 'ok' && snapshot.windows.length > 0) expired.push(snapshot);
  }
  if (open.length === 0) return null;

  const named = (core: AgentProvider): string =>
    quotaCoreLabel(coreLabel(core), accountOf?.(core));

  const level = levelOf(open, thresholdPct);
  const segments = open.map(
    ({ snapshot, window }) => `${named(snapshot.core)} ${Math.round(window.usedPct)}%`,
  );
  const tooltip = open
    .map(({ snapshot, window }) =>
      quotaWindowTooltipLine(named(snapshot.core), window, now, snapshot.readAt),
    )
    .concat(expired.map((snapshot) => quotaExpiredTooltipLine(named(snapshot.core))))
    .concat(quotaWarnThresholdText(thresholdPct))
    .join('\n');

  return {
    text: `${glyphFor(level)} ${segments.join(' · ')}`,
    tooltip,
    level,
  };
}
