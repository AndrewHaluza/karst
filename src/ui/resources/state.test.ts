import { describe, expect, it } from 'vitest';
import { buildResourcesState, toDiskRows } from './state.js';
import type { ResourceReading } from '../../runtime/resourceMonitor.js';
import type { DiskUsage } from '../../runtime/worktreeDisk.js';

const reading: ResourceReading = {
  supported: true,
  degraded: false,
  skipped: 0,
  fastLane: true,
  inventory: {
    takenMs: 200_000,
    cwdProbes: 1,
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
      ticketKey: '',
      ticketTitle: '',
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

  it('resolves ticket ids to key and title when a lifecycle map is supplied', () => {
    const state = buildResourcesState(reading, [], undefined, {
      lifecycle: new Map([[7, { key: 'IMP-7', title: 'Fix the widget' }]]),
    });
    expect(state.rows[0]).toMatchObject({ ticketKey: 'IMP-7', ticketTitle: 'Fix the widget' });
    // A row with no ticket keeps empty identity, never an invented one.
    expect(state.rows[1]!.ticketKey).toBe('');
  });

  it('renders an unmeasured row as em-dash, never a coerced zero', () => {
    const state = buildResourcesState(reading, []);
    expect(state.rows[1]).toMatchObject({
      ticketKey: '',
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
    const state = buildResourcesState({ supported: false, degraded: false, inventory: null, waste: [], history: [], skipped: 0, fastLane: false }, []);
    expect(state.supported).toBe(false);
    expect(state.rows).toEqual([]);
    expect(state.cpuPctDisplay).toBe('—');
    expect(state.attributedRoots).toBe(0);
    expect(state.unattributedShown).toBe(0);
  });

  it('renders a GB-sized disk lane', () => {
    const disk: DiskUsage[] = [{ path: '/repo/.karst/worktrees/x', bytes: 2 * 1024 * 1024 * 1024, measuredMs: 5 }];
    const state = buildResourcesState(reading, disk);
    expect(state.disk[0]!.sizeDisplay).toBe('2.0 GB');
  });

  it('counts the summary rail from the lanes', () => {
    const state = buildResourcesState(reading, []);
    expect(state.wasteCount).toBe(1);
    expect(state.attributedRoots).toBe(2);
    expect(state.unattributedShown).toBe(1);
  });

  it('renders the sample-age line from the newest sample and an injected now', () => {
    const state = buildResourcesState(reading, [], undefined, { now: 200_800 });
    expect(state.sampleAgeDisplay).toBe('sampled 0.8s ago');
    const beforeFirst = buildResourcesState(
      { supported: true, degraded: false, inventory: null, waste: [], history: [], skipped: 0, fastLane: false },
      [],
      undefined,
      { now: 1 },
    );
    expect(beforeFirst.sampleAgeDisplay).toBe('sampling…');
  });

  it('carries the scope label through', () => {
    const state = buildResourcesState(reading, [], undefined, { scopeLabel: 'Project karst · this window' });
    expect(state.scopeLabel).toBe('Project karst · this window');
  });

  it('derives trend scale markers and time ticks from history', () => {
    const history: ResourceReading['history'] = [
      { takenMs: 0, totals: { rssBytes: 100, cpuPct: 10 } },
      { takenMs: 60_000, totals: { rssBytes: 200, cpuPct: 30 } },
      { takenMs: 120_000, totals: { rssBytes: 300, cpuPct: 20 } },
    ];
    const state = buildResourcesState({ ...reading, history }, []);
    expect(state.trend.rssMaxDisplay).toBe('300 B');
    expect(state.trend.cpuMaxDisplay).toBe('30%');
    expect(state.trend.timeTicks[state.trend.timeTicks.length - 1]).toEqual({ label: 'now', fraction: 1 });
    expect(state.trend.timeTicks[0]).toEqual({ label: '-2m', fraction: 0 });
  });

  it('sets a y-axis scale: a host-formatted label for both series per gridline', () => {
    const history: ResourceReading['history'] = [
      { takenMs: 0, totals: { rssBytes: 100, cpuPct: 10 } },
      { takenMs: 60_000, totals: { rssBytes: 200, cpuPct: 30 } },
      { takenMs: 120_000, totals: { rssBytes: 300, cpuPct: 20 } },
    ];
    const state = buildResourcesState({ ...reading, history }, []);
    // Maxima: rss 300 B, cpu 30%. Ticks at 25/50/75% of the maximum.
    expect(state.trend.yTicks).toEqual([
      { fraction: 0.25, cpu: '8%', rss: '75 B' },
      { fraction: 0.5, cpu: '15%', rss: '150 B' },
      { fraction: 0.75, cpu: '23%', rss: '225 B' },
    ]);
  });

  it('reports an em-dash cpu y-tick when the cpu series is unmeasured', () => {
    const history: ResourceReading['history'] = [
      { takenMs: 0, totals: { rssBytes: 100, cpuPct: null } },
      { takenMs: 60_000, totals: { rssBytes: 200, cpuPct: null } },
    ];
    const state = buildResourcesState({ ...reading, history }, []);
    expect(state.trend.yTicks[0]).toMatchObject({ cpu: '—' });
    expect(state.trend.yTicks.every((t) => t.rss !== '0 B')).toBe(true);
  });

  it('reports CPU trend and the recent spark values', () => {
    const rising: ResourceReading['history'] = [
      { takenMs: 0, totals: { rssBytes: 100, cpuPct: 5 } },
      { takenMs: 1, totals: { rssBytes: 100, cpuPct: 10 } },
      { takenMs: 2, totals: { rssBytes: 100, cpuPct: 20 } },
      { takenMs: 3, totals: { rssBytes: 100, cpuPct: 40 } },
      { takenMs: 4, totals: { rssBytes: 100, cpuPct: 80 } },
    ];
    const state = buildResourcesState({ ...reading, history: rising }, []);
    expect(state.cpuTrend).toBe('rising');
    expect(state.recentCpu).toEqual([5, 10, 20, 40, 80]);
    expect(state.facts.find((f) => f.label === 'Recent CPU')?.value).toBe('rising');
  });

  it('builds the monitor facts lane from the reading', () => {
    const state = buildResourcesState({ ...reading, skipped: 2, fastLane: true }, []);
    const facts = Object.fromEntries(state.facts.map((f) => [f.label, f.value]));
    expect(facts['Sampling lane']).toBe('Fast · 2s');
    expect(facts['Skipped overlaps']).toBe('2');
    expect(facts['CWD probes']).toBe('1 / 3 · slow lane only');
    expect(facts['Disk lane']).toBe('panel open');
  });

  it('reports the slow lane when the fast lane is off', () => {
    const state = buildResourcesState({ ...reading, fastLane: false }, []);
    expect(state.facts.find((f) => f.label === 'Sampling lane')?.value).toBe('Slow · 30s');
  });
});

describe('toDiskRows', () => {
  it('applies repoDisplayPath with a PathContext', () => {
    const disk: DiskUsage[] = [{ path: '/repo/.karst/worktrees/x', bytes: 100, measuredMs: 5 }];
    const rows = toDiskRows(disk, { display: 'relative', projectRoot: '/repo' });
    expect(rows[0]!.display).toBe('./.karst/worktrees/x');
  });
});
