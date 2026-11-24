import { formatDoctorBytes } from './formatBytes.js';
import type { DoctorCheck } from './types.js';

/**
 * Storage usage check for `karst doctor` (arch:CLI-16). PURE: the walk arrives
 * as plain totals. Report-only by design — the doctor NEVER removes storage
 * data, it only names the retention settings that limit growth.
 */

/**
 * Warn threshold for the whole Karst storage folder. Binary, like the one byte
 * formatter (DR-8): 5 GiB. A decimal 5e9 would warn at a size the page prints
 * as "4.7 GB", so the threshold and the number would disagree.
 */
export const STORAGE_WARN_BYTES = 5 * 2 ** 30;

/** How many direct children the detail line names (the largest ones). */
export const STORAGE_TOP_CHILDREN = 5;

/** One direct child of the storage root and the bytes it holds. */
export interface StorageChildUsage {
  readonly name: string;
  readonly bytes: number;
}

/** Bytes under the storage root; `partial` when the walk stopped at its budget. */
export interface StorageUsage {
  readonly totalBytes: number;
  readonly entries: readonly StorageChildUsage[];
  readonly partial: boolean;
}

/** The largest children first, ties by name so the line is stable between runs. */
function topChildren(entries: readonly StorageChildUsage[]): StorageChildUsage[] {
  return [...entries]
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, STORAGE_TOP_CHILDREN);
}

export function checkStorage(probe: StorageUsage): DoctorCheck {
  const over = probe.totalBytes >= STORAGE_WARN_BYTES;
  const top = topChildren(probe.entries);
  const total = `Karst storage is ${formatDoctorBytes(probe.totalBytes)}`;
  const children = top.map((e) => `${e.name} ${formatDoctorBytes(e.bytes)}`).join(', ');
  const detail = `${top.length === 0 ? total : `${total} (${children})`}${probe.partial ? ' (partial)' : ''}`;
  return {
    id: 'state.storage',
    area: 'state',
    status: over ? 'warn' : 'ok',
    title: 'Karst storage',
    detail,
    ...(over
      ? {
          fix: {
            tier: 'report' as const,
            summary: `Karst storage is at or above ${formatDoctorBytes(STORAGE_WARN_BYTES)}`,
            nextStep:
              'Limit storage growth by setting or lowering archiveDoneAfterDays, archivePlanningAfterDays, and artifacts.maxAgeDays in karst.yml.',
          },
        }
      : {}),
  };
}
