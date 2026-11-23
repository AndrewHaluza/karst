import { describeWaste } from '../runtime/wasteFindings.js';
import type { ResourceReading } from '../runtime/resourceMonitor.js';
import { plural } from '../model/notifyText.js';

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

const NO_VALUE = '—';

export function buildResourceIndicator(reading: ResourceReading): ResourceIndicator | null {
  if (!reading.supported) return null;
  if (reading.inventory === null) return null;

  if (reading.waste.length > 0) {
    const lines = reading.waste.slice(0, TOOLTIP_LINE_CAP).map(describeWaste);
    const overflow = reading.waste.length - lines.length;
    const tooltip = lines.concat(overflow > 0 ? [`…and ${overflow} more`] : []).join('\n');
    return {
      text: `$(warning) Karst: ${plural(reading.waste.length, 'leaked process', 'leaked processes')}`,
      tooltip,
      warning: true,
    };
  }

  const attributed = reading.inventory.attributed;
  // Nothing of karst's runs: a "0 B" meter would read as a measured value.
  if (attributed.length === 0) return null;
  const totals = reading.inventory.totals;
  const measured = attributed.some((row) => row.cost !== null);
  const cpu = totals.cpuPct === null ? NO_VALUE : `${Math.round(totals.cpuPct)}%`;
  const rss = measured ? formatBytes(totals.rssBytes) : NO_VALUE;
  const procCount = attributed.reduce((sum, row) => sum + (row.cost?.procCount ?? 0), 0);
  const last = reading.history[reading.history.length - 1];
  const ageSeconds = last ? Math.max(0, Math.round((Date.now() - last.takenMs) / 1000)) : 0;
  return {
    text: `$(pulse) Karst: ${cpu} · ${rss}`,
    tooltip: `${plural(procCount, 'process', 'processes')} attributed · last reading ${ageSeconds}s ago`,
    warning: false,
  };
}
