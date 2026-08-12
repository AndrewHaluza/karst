import { describeWaste } from '../runtime/wasteFindings.js';
import type { ResourceReading } from '../runtime/resourceMonitor.js';

/**
 * Pure status-bar builder for the resource monitor, the same shape
 * `buildDepsIndicator` uses: the `vscode` binding stays in `extension.ts`.
 *
 * Returns `null` when there is nothing worth showing — unsupported platform, or
 * no reading yet. A permanent empty badge is noise on the one surface the user
 * cannot dismiss, the same reasoning `buildDepsIndicator` documents.
 *
 * With waste, the badge turns amber and names the count; the tooltip lists the
 * findings (capped at five lines plus an overflow line). Without waste it is a
 * live meter of karst's own footprint.
 */

export interface ResourceIndicator {
  text: string;
  tooltip: string;
  warning: boolean;
}

const TOOLTIP_LINE_CAP = 5;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function buildResourceIndicator(reading: ResourceReading): ResourceIndicator | null {
  if (!reading.supported) return null;
  if (reading.inventory === null) return null;
  const totals = reading.inventory.totals;
  const cpu = totals.cpuPct === null ? '—' : `${Math.round(totals.cpuPct)}%`;
  const rss = formatBytes(totals.rssBytes);

  if (reading.waste.length > 0) {
    const lines = reading.waste.slice(0, TOOLTIP_LINE_CAP).map(describeWaste);
    const overflow = reading.waste.length - lines.length;
    const tooltip = lines.concat(overflow > 0 ? [`…and ${overflow} more`] : []).join('\n');
    return {
      text: `$(warning) Karst: ${reading.waste.length} leaked`,
      tooltip,
      warning: true,
    };
  }

  const procCount = reading.inventory.attributed.reduce(
    (sum, row) => sum + (row.cost?.procCount ?? 0),
    0,
  );
  const last = reading.history[reading.history.length - 1];
  const ageSeconds = last ? Math.max(0, Math.round((Date.now() - last.takenMs) / 1000)) : 0;
  return {
    text: `$(pulse) Karst ${cpu} · ${rss}`,
    tooltip: `${procCount} processes attributed · last reading ${ageSeconds}s ago`,
    warning: false,
  };
}
