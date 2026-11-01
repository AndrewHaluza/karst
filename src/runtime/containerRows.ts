import { parseSandboxContainerName } from '../agent/sandboxInventory.js';
import type { ContainerStat } from './containerSampler.js';
import type { AttributedRow, Inventory, VmOverhead } from './resourceInventory.js';
import { sumCosts, treeCost, type TreeCost } from './procTreeCost.js';
import type { ProcSnapshot } from './procSnapshot.js';
import type { RunningServerRow } from '../store/runningServers.js';

/**
 * Fold one container reading into an inventory (pure; returns a new one):
 *  - a dev-server container's stats are merged INTO its server row (no second
 *    row; the docker client pid already in that row costs ~0);
 *  - every other karst sandbox container becomes a `container` row attributed
 *    to its ticket, with no Kill (no pid, no `servers` row);
 *  - `vmOverhead` = VM host cost minus ALL karst containers, floored at 0, and
 *    never counted in `totals`.
 */

const VM_COMM = /(^|\/)(com\.docker\.virtualization|[^/]*sbx[^/]*(vm|virtualization)[^/]*)$/i;

/** Summed tree cost of the container-VM host processes, or null when none run. */
export function vmProcessCost(
  snapshot: ProcSnapshot,
  previous: ProcSnapshot | null,
  cpuCoreCount?: number,
): VmOverhead | null {
  const matches = new Set<number>();
  for (const rec of snapshot.records.values()) if (VM_COMM.test(rec.comm)) matches.add(rec.pid);
  const costs: TreeCost[] = [];
  for (const pid of matches) {
    if (matches.has(snapshot.records.get(pid)!.ppid)) continue; // counted under its parent
    const cost = treeCost(snapshot, previous, pid, cpuCoreCount);
    if (cost) costs.push(cost);
  }
  if (costs.length === 0) return null;
  const sum = sumCosts(costs);
  return { ...sum, procCount: costs.reduce((n, c) => n + c.procCount, 0) };
}

function addCpu(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function statCost(stat: ContainerStat, pid: number): TreeCost {
  return { pid, rssBytes: stat.rssBytes, cpuPct: stat.cpuPct, procCount: 1, startedMs: null };
}

export function applyContainers(opts: {
  inventory: Inventory;
  stats: readonly ContainerStat[] | null;
  servers: readonly RunningServerRow[];
  projectRoot: string;
  vm: VmOverhead | null;
}): Inventory {
  const { inventory, stats, servers, projectRoot, vm } = opts;
  const byName = new Map((stats ?? []).map((s) => [s.name, s]));
  const serverByContainer = new Map<string, number>();
  for (const s of servers) if (s.container) serverByContainer.set(s.container, s.id);

  const mergedInto = new Map<number, ContainerStat>();
  const rows: AttributedRow[] = [];
  for (const stat of byName.values()) {
    const serverId = serverByContainer.get(stat.name);
    if (serverId !== undefined) {
      mergedInto.set(serverId, stat);
      continue;
    }
    const id = parseSandboxContainerName(stat.name, projectRoot);
    if (!id) continue;
    rows.push({
      pid: 0,
      kind: 'container',
      ticketId: id.ticketId,
      label: `sandbox ${id.core}${id.suffix ? ` ${id.suffix}` : ''}`,
      serverId: null,
      attribution: 'attributable',
      cost: statCost(stat, 0),
      cwd: null,
      comm: stat.name,
    });
  }

  const attributed: AttributedRow[] = inventory.attributed.map((row) => {
    const stat = row.serverId === null ? undefined : mergedInto.get(row.serverId);
    if (!stat) return row;
    const cost: TreeCost = row.cost
      ? { ...row.cost, rssBytes: row.cost.rssBytes + stat.rssBytes, cpuPct: addCpu(row.cost.cpuPct, stat.cpuPct) }
      : statCost(stat, row.pid);
    return { ...row, cost };
  });
  attributed.push(...rows);

  const containerRss = [...byName.values()].reduce((n, s) => n + s.rssBytes, 0);
  const containerCpu = [...byName.values()].reduce<number | null>((n, s) => addCpu(n, s.cpuPct), null);
  const vmOverhead: VmOverhead | null =
    vm === null
      ? null
      : {
          rssBytes: Math.max(0, vm.rssBytes - containerRss),
          cpuPct: vm.cpuPct === null ? null : Math.max(0, vm.cpuPct - (containerCpu ?? 0)),
          procCount: vm.procCount,
        };

  const totals = sumCosts(attributed.map((r) => r.cost).filter((c): c is TreeCost => c !== null));
  return { ...inventory, attributed, totals, vmOverhead };
}
