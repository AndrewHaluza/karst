import { describe, expect, it } from 'vitest';
import { buildResourcesState, toDiskRows } from './state.js';
import type { ResourceReading } from '../../runtime/resourceMonitor.js';
import type { DiskUsage } from '../../runtime/worktreeDisk.js';

const reading: ResourceReading = {
  supported: true,
  degraded: false,
  inventory: {
    takenMs: 200_000,
    attributed: [
      {
        pid: 100,
        kind: 'server',
        ticketId: 7,
        label: 'web',
        serverId: 1,
        attribution: 'attributable',
        cost: { pid: 100, rssBytes: 60, cpuPct: 50, procCount: 3, startedMs: 100_000 },
        cwd: '/wt/x',
        comm: 'npm',
      },
      {
        pid: 101,
        kind: 'agent',
        ticketId: null,
        label: 'impl',
        serverId: null,
        attribution: 'dead',
        cost: null,
        cwd: null,
        comm: '',
      },
    ],
    unattributed: [
      {
        pid: 300,
        comm: 'node',
        cost: { pid: 300, rssBytes: 400 * 1024 * 1024, cpuPct: null, procCount: 1, startedMs: null },
        cwd: null,
        cwdDeleted: false,
      },
    ],
    totals: { rssBytes: 60, cpuPct: 50 },
  },
  waste: [
    {
      kind: 'worktree-gone',
      pid: 100,
      serverId: 1,
      ticketId: 7,
      reason: 'web server still running in a worktree that no longer exists (/wt)',
      rssBytes: 60,
      killable: true,
    },
  ],
  history: [{ takenMs: 200_000, totals: { rssBytes: 60, cpuPct: 50 } }],
};

describe('buildResourcesState', () => {
  it('renders an attributed row with host-side strings', () => {
    const state = buildResourcesState(reading, []);
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({
      ticketLabel: '#7',
      label: 'web',
      pid: 100,
      cpuPct: 50,
      cpuPctDisplay: '50%',
      rssBytes: 60,
      rssDisplay: '60 B',
      procCount: 3,
      uptimeMs: 100_000,
      uptimeDisplay: '1m 40s',
      attribution: 'attributable',
    });
  });

  it('renders an unmeasured row as em-dash, never a coerced zero', () => {
    const state = buildResourcesState(reading, []);
    expect(state.rows[1]).toMatchObject({
      ticketLabel: '',
      cpuPctDisplay: '—',
      rssDisplay: '0 B',
      uptimeDisplay: '',
    });
  });

  it('renders unattributed rows', () => {
    const state = buildResourcesState(reading, []);
    expect(state.unknown).toHaveLength(1);
    expect(state.unknown[0]).toMatchObject({
      pid: 300,
      comm: 'node',
      rssDisplay: '400.0 MB',
      cpuPctDisplay: '—',
      procCount: 1,
    });
  });

  it('renders waste rows with the killable flag and a formatted size', () => {
    const state = buildResourcesState(reading, []);
    expect(state.waste).toHaveLength(1);
    expect(state.waste[0]).toMatchObject({
      kind: 'worktree-gone',
      reason: 'web server still running in a worktree that no longer exists (/wt)',
      rssBytes: 60,
      rssDisplay: '60 B',
      killable: true,
      serverId: 1,
    });
  });

  it('renders the totals meter', () => {
    const state = buildResourcesState(reading, []);
    expect(state.totals).toEqual({ rssBytes: 60, cpuPct: 50 });
    expect(state.rssDisplay).toBe('60 B');
    expect(state.cpuPctDisplay).toBe('50%');
  });

  it('carries history through for the sparkline', () => {
    const state = buildResourcesState(reading, []);
    expect(state.history).toEqual(reading.history);
  });

  it('reports an unsupported reading without an inventory', () => {
    const state = buildResourcesState({ supported: false, degraded: false, inventory: null, waste: [], history: [] }, []);
    expect(state.supported).toBe(false);
    expect(state.rows).toEqual([]);
    expect(state.cpuPctDisplay).toBe('—');
  });

  it('renders a GB-sized disk lane', () => {
    const disk: DiskUsage[] = [{ path: '/repo/.karst/worktrees/x', bytes: 2 * 1024 * 1024 * 1024, measuredMs: 5 }];
    const state = buildResourcesState(reading, disk);
    expect(state.disk[0]!.sizeDisplay).toBe('2.0 GB');
  });
});

describe('toDiskRows', () => {
  it('applies repoDisplayPath with a PathContext', () => {
    const disk: DiskUsage[] = [{ path: '/repo/.karst/worktrees/x', bytes: 100, measuredMs: 5 }];
    const rows = toDiskRows(disk, { display: 'relative', projectRoot: '/repo' });
    expect(rows[0]!.display).toBe('./.karst/worktrees/x');
  });
});
