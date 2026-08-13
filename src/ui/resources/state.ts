import { repoDisplayPath, type PathContext } from '../worktreePath.js';
import type { ResourceReading, ResourceSample } from '../../runtime/resourceMonitor.js';
import { MAX_CWD_PROBES_PER_TICK } from '../../runtime/resourceInventory.js';
import { RING_CAPACITY } from '../../runtime/resourceMonitor.js';
import type { DiskUsage } from '../../runtime/worktreeDisk.js';
import type { Attribution } from '../../runtime/serverIdentity.js';

/**
 * The resource-monitor view's read model.
 *
 * Every display string — bytes, percent, uptime, sample age, trend scale — is
 * rendered HERE, host-side, for the same reason `prPanelView.ts` and
 * `usage/state.ts` do it: the webview cannot import a formatter, so anything it
 * formats itself is a second implementation of the rule. An absent fact renders
 * `''` or `—`, never a placeholder that could read as a measured zero.
 *
 * Every PATH shown (the disk lane) goes through `repoDisplayPath` + `PathContext`,
 * the one formatter the ship/PR surfaces already share.
 *
 * Ticket identity is resolved HERE from a `lifecycle` map (id → key/title) the
 * panel supplies: the attributed rows carry only `tickets.id`, which is not a
 * label the user can match against their board — the key/title are.
 */

/** Identity a `tickets.id` resolves to for the attributed lane. */
export interface TicketIdentity {
  key: string | null;
  title: string | null;
}

export interface ResourceRowView {
  /** Resolved ticket key (`869ehdnec`), or `''` for a baseline server. */
  ticketKey: string;
  /** Resolved ticket title, or `''` when absent. */
  ticketTitle: string;
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

/** One x-axis tick of the trend chart: a label and where it sits (0..1). */
export interface TrendTick {
  label: string;
  fraction: number;
}

/** One row of the Monitor facts lane. */
export interface MonitorFact {
  label: string;
  value: string;
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
  /** "sampled 0.8s ago" from the newest sample; "sampling…" before the first. */
  sampleAgeDisplay: string;
  /** "Project <name> · this window" — the panel's scope line. */
  scopeLabel: string;
  wasteCount: number;
  attributedRoots: number;
  unattributedShown: number;
  /** Trend chart scale: per-series maxima + x-axis time ticks. */
  trend: {
    cpuMaxDisplay: string;
    rssMaxDisplay: string;
    timeTicks: TrendTick[];
  };
  /** Ring capacity the trend spans (`/ 150` of the "5-minute window"). */
  historyMax: number;
  cpuTrend: 'rising' | 'falling' | 'steady';
  /** Last few raw CPU values for the Recent-CPU mini spark (geometry only). */
  recentCpu: number[];
  facts: MonitorFact[];
}

export interface BuildResourcesStateOptions {
  /** Ticket id → key/title for the attributed lane (default: no resolution). */
  lifecycle?: ReadonlyMap<number, TicketIdentity>;
  /** The scope line shown under the title (default: ''). */
  scopeLabel?: string;
  /** Wall clock for the sample-age line (default: Date.now). */
  now?: number;
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

/** "sampled 0.8s ago" from the newest sample timestamp. */
function sampleAgeDisplay(now: number, history: readonly ResourceSample[]): string {
  const last = history[history.length - 1];
  if (!last) return 'sampling…';
  const secs = Math.max(0, (now - last.takenMs) / 1000);
  if (secs < 10) return `sampled ${secs.toFixed(1)}s ago`;
  if (secs < 60) return `sampled ${Math.round(secs)}s ago`;
  return `sampled ${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s ago`;
}

/** Per-series maxima + whole-minute x-axis ticks derived from real timestamps. */
function trendView(history: readonly ResourceSample[]): ResourcesState['trend'] {
  const cpu = history.map((s) => s.totals.cpuPct).filter((v): v is number => v !== null);
  const rss = history.map((s) => s.totals.rssBytes);
  const cpuMax = cpu.length ? Math.max(...cpu) : null;
  const rssMax = rss.length ? Math.max(...rss) : 0;

  const timeTicks: TrendTick[] = [];
  if (history.length >= 2) {
    const first = history[0]!.takenMs;
    const last = history[history.length - 1]!.takenMs;
    const span = last - first;
    if (span > 0) {
      const maxMinutes = Math.min(5, Math.floor(span / 60_000));
      for (let m = 1; m <= maxMinutes; m += 1) {
        const target = last - m * 60_000;
        if (target < first) continue;
        timeTicks.push({ label: `-${m}m`, fraction: (target - first) / span });
      }
      timeTicks.push({ label: 'now', fraction: 1 });
      timeTicks.sort((a, b) => a.fraction - b.fraction);
    }
  } else if (history.length === 1) {
    timeTicks.push({ label: 'now', fraction: 1 });
  }

  return { cpuMaxDisplay: percent(cpuMax), rssMaxDisplay: formatBytes(rssMax), timeTicks };
}

/** Whether recent CPU is climbing, falling, or flat relative to earlier samples. */
function cpuTrend(history: readonly ResourceSample[]): 'rising' | 'falling' | 'steady' {
  const cpu = history.map((s) => s.totals.cpuPct).filter((v): v is number => v !== null);
  if (cpu.length < 4) return 'steady';
  const half = Math.floor(cpu.length / 2);
  const first = cpu.slice(0, half);
  const second = cpu.slice(half);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const base = avg(cpu);
  if (base <= 0) return 'steady';
  const delta = avg(second) - avg(first);
  if (delta > base * 0.15) return 'rising';
  if (delta < -base * 0.15) return 'falling';
  return 'steady';
}

export function buildResourcesState(
  reading: ResourceReading,
  disk: readonly DiskUsage[],
  pathContext?: PathContext,
  options: BuildResourcesStateOptions = {},
): ResourcesState {
  const inventory = reading.inventory;
  const takenMs = inventory?.takenMs ?? 0;
  const lifecycle = options.lifecycle ?? new Map<number, TicketIdentity>();

  const rows: ResourceRowView[] = (inventory?.attributed ?? []).map((row) => {
    const up = uptimeMs(row.cost?.startedMs ?? null, takenMs);
    const identity = row.ticketId === null ? undefined : lifecycle.get(row.ticketId);
    return {
      ticketKey: identity?.key ?? '',
      ticketTitle: identity?.title ?? '',
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
  const recentCpu = reading.history
    .map((s) => s.totals.cpuPct)
    .filter((v): v is number => v !== null)
    .slice(-6);
  const trend = trendView(reading.history);
  const trendWord = cpuTrend(reading.history);
  const cwdProbes = inventory?.cwdProbes ?? 0;

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
    sampleAgeDisplay: sampleAgeDisplay(options.now ?? Date.now(), reading.history),
    scopeLabel: options.scopeLabel ?? '',
    wasteCount: waste.length,
    attributedRoots: rows.length,
    unattributedShown: unknown.length,
    trend,
    cpuTrend: trendWord,
    recentCpu,
    historyMax: RING_CAPACITY,
    facts: [
      { label: 'Sampling lane', value: reading.fastLane ? 'Fast · 2s' : 'Slow · 30s' },
      { label: 'Snapshot cost', value: '1 × ps' },
      { label: 'Skipped overlaps', value: String(reading.skipped) },
      { label: 'CWD probes', value: `${cwdProbes} / ${MAX_CWD_PROBES_PER_TICK} · slow lane only` },
      { label: 'Disk lane', value: 'panel open' },
      { label: 'Recent CPU', value: trendWord },
    ],
  };
}
