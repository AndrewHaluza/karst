import { describe, expect, it } from 'vitest';
import { applyContainers, vmProcessCost } from './containerRows.js';
import { parseProcTable } from './procSnapshot.js';
import { projectPrefix } from '../agent/sandboxInventory.js';
import type { AttributedRow, Inventory } from './resourceInventory.js';
import type { RunningServerRow } from '../store/runningServers.js';

const ROOT = '/proj';
const P = projectPrefix(ROOT);

const serverRow: AttributedRow = {
  pid: 50, kind: 'server', ticketId: 3, label: 'api', serverId: 9, attribution: 'attributable',
  cost: { pid: 50, rssBytes: 1000, cpuPct: 0, procCount: 1, startedMs: 5 }, cwd: '/w', comm: 'docker',
};
const base = (): Inventory => ({
  takenMs: 1, attributed: [serverRow], unattributed: [], totals: { rssBytes: 1000, cpuPct: 0 }, cwdProbes: 0,
});
const server = (container: string | null): RunningServerRow => ({
  id: 9, ticketId: 3, repo: 'api', pid: 50, cwd: '/w', startedAt: null, host: null, port: null, container,
});
const stat = (name: string, rssBytes: number, cpuPct: number | null = 2) => ({ name, rssBytes, cpuPct });
const vm = { rssBytes: 10_000, cpuPct: 30, procCount: 2 };

describe('applyContainers', () => {
  it('adds sandbox containers as ticket-attributed rows by suffix-stripped name', () => {
    const inv = applyContainers({
      inventory: base(), servers: [], projectRoot: ROOT, vm: null,
      stats: [stat(`${P}7-claude`, 100), stat(`${P}7-claude-proxy`, 50), stat('someone-elses', 999)],
    });
    const rows = inv.attributed.filter((r) => r.kind === 'container');
    expect(rows.map((r) => [r.ticketId, r.label, r.pid, r.serverId])).toEqual([
      [7, 'sandbox claude', 0, null],
      [7, 'sandbox claude proxy', 0, null],
    ]);
    expect(inv.totals.rssBytes).toBe(1150);
  });

  it('merges a dev-server container into its server row: one row, no double count', () => {
    const inv = applyContainers({
      inventory: base(), servers: [server('karst-t3-pg')], projectRoot: ROOT, vm: null,
      stats: [stat('karst-t3-pg', 500, 4)],
    });
    expect(inv.attributed).toHaveLength(1);
    expect(inv.attributed[0]!.cost).toMatchObject({ rssBytes: 1500, cpuPct: 4 });
    expect(inv.totals.rssBytes).toBe(1500);
  });

  it('VM overhead = VM minus all containers, never negative, excluded from totals', () => {
    const inv = applyContainers({
      inventory: base(), servers: [server('karst-t3-pg')], projectRoot: ROOT, vm,
      stats: [stat('karst-t3-pg', 500, 4), stat(`${P}7-claude`, 100, 6)],
    });
    expect(inv.vmOverhead).toEqual({ rssBytes: 9400, cpuPct: 20, procCount: 2 });
    expect(inv.totals.rssBytes).toBe(1600);
    const over = applyContainers({ inventory: base(), servers: [], projectRoot: ROOT, vm, stats: [stat(`${P}7-claude`, 99_999, 90)] });
    expect(over.vmOverhead).toMatchObject({ rssBytes: 0, cpuPct: 0 });
  });

  it('keeps VM cpu unmeasured as null and shows the whole VM when there is no reading', () => {
    const inv = applyContainers({ inventory: base(), servers: [], projectRoot: ROOT, vm: { ...vm, cpuPct: null }, stats: null });
    expect(inv.vmOverhead).toEqual({ rssBytes: 10_000, cpuPct: null, procCount: 2 });
    expect(applyContainers({ inventory: base(), servers: [], projectRoot: ROOT, vm: null, stats: [] }).vmOverhead).toBeNull();
  });

  it('does not mutate its input', () => {
    const inv = base();
    applyContainers({ inventory: inv, servers: [server('c')], projectRoot: ROOT, vm, stats: [stat('c', 5)] });
    expect(inv.attributed[0]!.cost!.rssBytes).toBe(1000);
    expect(inv.vmOverhead).toBeUndefined();
  });
});

describe('vmProcessCost', () => {
  const line = (pid: number, ppid: number, rssKb: number, comm: string): string =>
    `${pid} ${ppid} ${rssKb} 0:01.00 Tue Aug 12 10:33:21 2026 ${comm}`;
  it('sums VM processes once and ignores others', () => {
    const snap = parseProcTable(
      [
        line(1, 0, 10, '/sbin/launchd'),
        line(10, 1, 100, '/Applications/Docker.app/Contents/MacOS/com.docker.virtualization'),
        line(11, 10, 50, '/x/com.docker.virtualization'),
        line(20, 1, 70, '/usr/local/bin/sbx-vm'),
        line(30, 1, 999, '/usr/bin/other'),
      ].join('\n'),
      1000,
    );
    expect(vmProcessCost(snap, null)).toMatchObject({ rssBytes: (100 + 50 + 70) * 1024, procCount: 3 });
  });
  it('is null when no VM runs', () => {
    expect(vmProcessCost(parseProcTable(line(1, 0, 10, '/sbin/launchd'), 1), null)).toBeNull();
  });
});
