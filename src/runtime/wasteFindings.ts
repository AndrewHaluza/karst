import { dirname } from 'node:path';
import { isPathUnder } from './pathScope.js';
import type { Inventory } from './resourceInventory.js';
import type { RunningServerRow, TicketLifecycle } from '../store/runningServers.js';

/**
 * Name only resources karst can PROVE are leaked. Waste is a CLOSED set of
 * three conditions, each provable from evidence karst already holds:
 *
 *  - `worktree-gone`: an attributed server whose recorded cwd no longer exists
 *    AND whose PARENT still does (an unmounted volume is not a deletion — the
 *    rule `reapStaleServers` already uses).
 *  - `ticket-finished`: an attributed server whose ticket is done or archived.
 *  - `orphan-worktree-process`: an UNATTRIBUTED process whose confirmed live
 *    cwd is under a known worktree root and which matches no running server.
 *
 * Nothing else is waste. Busy CPU is not waste — a real `npm test` should peg a
 * core. Only `worktree-gone` and `ticket-finished` are killable: they have a
 * `servers` row, so `attributeServer` can produce evidence. An orphan has no
 * recorded start time, so the strongest evidence is a cwd match, and the blast
 * radius of a wrong answer is a whole process group.
 */
export type WasteKind = 'worktree-gone' | 'ticket-finished' | 'orphan-worktree-process';

export interface WasteFinding {
  kind: WasteKind;
  pid: number;
  /** `servers.id` when the finding has a row to act on; null for an orphan. */
  serverId: number | null;
  ticketId: number | null;
  /** One line naming what is wasted and why it is provably waste. */
  reason: string;
  rssBytes: number;
  /** Only findings with a `servers` row may be signalled. */
  killable: boolean;
}

export interface DirectoryProbe {
  exists(path: string): boolean;
}

export function findWaste(opts: {
  inventory: Inventory;
  servers: readonly RunningServerRow[];
  lifecycle: ReadonlyMap<number, TicketLifecycle>;
  /** Roots under which a process is considered to be inside a karst worktree. */
  worktreeRoots: readonly string[];
  dirs: DirectoryProbe;
}): WasteFinding[] {
  const { inventory, servers, lifecycle, worktreeRoots, dirs } = opts;

  const byServerId = new Map<number, RunningServerRow>();
  const serverPids = new Set<number>();
  for (const row of servers) {
    byServerId.set(row.id, row);
    if (row.pid !== null) serverPids.add(row.pid);
  }

  const findings: WasteFinding[] = [];
  const claimed = new Set<number>();
  const emit = (finding: WasteFinding): void => {
    if (claimed.has(finding.pid)) return;
    claimed.add(finding.pid);
    findings.push(finding);
  };

  // worktree-gone — only 'attributable' rows can ever be waste (an unmounted
  // volume, a foreign pid, or a dead pid is not provably a leak).
  for (const row of inventory.attributed) {
    if (row.serverId === null || row.ticketId === null) continue;
    if (row.attribution !== 'attributable') continue;
    const server = byServerId.get(row.serverId);
    if (!server || server.cwd === null) continue;
    if (dirs.exists(server.cwd) || !dirs.exists(dirname(server.cwd))) continue;
    emit({
      kind: 'worktree-gone',
      pid: row.pid,
      serverId: row.serverId,
      ticketId: row.ticketId,
      reason: `${server.repo} server still running in a worktree that no longer exists (${dirname(server.cwd)})`,
      rssBytes: row.cost?.rssBytes ?? 0,
      killable: true,
    });
  }

  // ticket-finished
  for (const row of inventory.attributed) {
    if (row.serverId === null || row.ticketId === null) continue;
    if (row.attribution !== 'attributable') continue;
    const life = lifecycle.get(row.ticketId);
    if (!life) continue;
    if (life.stageCurrent !== 'done' && !life.archived) continue;
    const server = byServerId.get(row.serverId);
    if (!server) continue;
    emit({
      kind: 'ticket-finished',
      pid: row.pid,
      serverId: row.serverId,
      ticketId: row.ticketId,
      reason: `${server.repo} server still running for ${life.archived ? 'an archived' : 'a completed'} ticket ${life.key ?? life.id}`,
      rssBytes: row.cost?.rssBytes ?? 0,
      killable: true,
    });
  }

  // orphan-worktree-process — report-only, never killable.
  for (const row of inventory.unattributed) {
    if (row.cwd === null) continue;
    if (serverPids.has(row.pid)) continue;
    const root = worktreeRoots.find((r) => isPathUnder(row.cwd!, r));
    if (!root) continue;
    emit({
      kind: 'orphan-worktree-process',
      pid: row.pid,
      serverId: null,
      ticketId: null,
      reason: `unattributed ${row.comm} (pid ${row.pid}) running inside a karst worktree${row.cwdDeleted ? ' that has been deleted' : ''}`,
      rssBytes: row.cost.rssBytes,
      killable: false,
    });
  }

  return findings;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function describeWaste(f: WasteFinding): string {
  return `${f.reason} — ${formatBytes(f.rssBytes)}`;
}
