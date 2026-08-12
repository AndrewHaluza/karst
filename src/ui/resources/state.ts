import { repoDisplayPath, type PathContext } from '../worktreePath.js';
import type { ResourceReading, ResourceSample } from '../../runtime/resourceMonitor.js';
import type { DiskUsage } from '../../runtime/worktreeDisk.js';
import type { Attribution } from '../../runtime/serverIdentity.js';

/**
 * The resource-monitor view's read model.
 *
 * Every display string — bytes, percent, uptime — is rendered HERE, host-side,
 * for the same reason `prPanelView.ts` and `usage/state.ts` do it: the webview
 * cannot import a formatter, so anything it formats itself is a second
 * implementation of the rule. An absent fact renders `''` or `—`, never a
 * placeholder that could read as a measured zero.
 *
 * Every PATH shown (the disk lane) goes through `repoDisplayPath` + `PathContext`,
 * the one formatter the ship/PR surfaces already share.
 */

export interface ResourceRowView {
  /** `#<id>` for a ticket-bound row; `''` for a baseline server. */
  ticketLabel: string;
  /** Repository name for a server; the call-site label for an agent/gate. */
  label: string;
  pid: number;
  cpuPct: number | null;
  cpuPctDisplay: string;
  rssBytes: number;
  rssDisplay: string;
  procCount: number;
  uptimeMs: number | null;
  uptimeDisplay: string;
  attribution: Attribution;
}

export interface UnknownRowView {
  pid: number;
  comm: string;
  rssDisplay: string;
  cpuPctDisplay: string;
  procCount: number;
}

export interface WasteRowView {
  kind: string;
  reason: string;
  rssBytes: number;
  rssDisplay: string;
  killable: boolean;
  serverId: number | null;
}

export interface DiskRowView {
  path: string;
  display: string;
  bytes: number;
  sizeDisplay: string;
  measuredMs: number;
}

export interface ResourcesState {
  supported: boolean;
  degraded: boolean;
  totals: { rssBytes: number; cpuPct: number | null };
  rssDisplay: string;
  cpuPctDisplay: string;
  rows: ResourceRowView[];
  unknown: UnknownRowView[];
  waste: WasteRowView[];
  history: readonly ResourceSample[];
  disk: DiskRowView[];
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** `—` for an unmeasured tree, never a coerced 0 (Key Decision 1). */
function percent(cpuPct: number | null): string {
  return cpuPct === null ? '—' : `${Math.round(cpuPct)}%`;
}

function uptimeMs(startedMs: number | null, takenMs: number): number | null {
  if (startedMs === null) return null;
  const ms = takenMs - startedMs;
  return ms >= 0 ? ms : null;
}

function formatUptime(ms: number | null): string {
  if (ms === null) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The disk view rows — shared by the state push and the incremental disk message. */
export function toDiskRows(disk: readonly DiskUsage[], pathContext?: PathContext): DiskRowView[] {
  return disk.map((u) => ({
    path: u.path,
    display: repoDisplayPath(u.path, pathContext),
    bytes: u.bytes,
    sizeDisplay: formatBytes(u.bytes),
    measuredMs: u.measuredMs,
  }));
}

export function buildResourcesState(
  reading: ResourceReading,
  disk: readonly DiskUsage[],
  pathContext?: PathContext,
): ResourcesState {
  const inventory = reading.inventory;
  const takenMs = inventory?.takenMs ?? 0;

  const rows: ResourceRowView[] = (inventory?.attributed ?? []).map((row) => {
    const up = uptimeMs(row.cost?.startedMs ?? null, takenMs);
    return {
      ticketLabel: row.ticketId === null ? '' : `#${row.ticketId}`,
      label: row.label ?? '',
      pid: row.pid,
      cpuPct: row.cost?.cpuPct ?? null,
      cpuPctDisplay: percent(row.cost?.cpuPct ?? null),
      rssBytes: row.cost?.rssBytes ?? 0,
      rssDisplay: formatBytes(row.cost?.rssBytes ?? 0),
      procCount: row.cost?.procCount ?? 0,
      uptimeMs: up,
      uptimeDisplay: formatUptime(up),
      attribution: row.attribution,
    };
  });

  const unknown: UnknownRowView[] = (inventory?.unattributed ?? []).map((row) => ({
    pid: row.pid,
    comm: row.comm,
    rssDisplay: formatBytes(row.cost.rssBytes),
    cpuPctDisplay: percent(row.cost.cpuPct),
    procCount: row.cost.procCount,
  }));

  const waste: WasteRowView[] = reading.waste.map((f) => ({
    kind: f.kind,
    reason: f.reason,
    rssBytes: f.rssBytes,
    rssDisplay: formatBytes(f.rssBytes),
    killable: f.killable,
    serverId: f.serverId,
  }));

  const totals = inventory?.totals ?? { rssBytes: 0, cpuPct: null };

  return {
    supported: reading.supported,
    degraded: reading.degraded,
    totals,
    rssDisplay: formatBytes(totals.rssBytes),
    cpuPctDisplay: percent(totals.cpuPct),
    rows,
    unknown,
    waste,
    history: reading.history,
    disk: toDiskRows(disk, pathContext),
  };
}
