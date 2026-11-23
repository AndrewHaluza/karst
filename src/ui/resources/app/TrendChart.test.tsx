import { describe, expect, it } from 'vitest';
import { buildResourcesState } from '../state.js';
import type { ResourceReading } from '../../../runtime/resourceMonitor.js';
import { trendEmptyText, trendSummary } from './TrendChart.js';

const reading: ResourceReading = {
  supported: true,
  degraded: false,
  skipped: 0,
  fastLane: true,
  inventory: {
    takenMs: 200_000,
    cwdProbes: 0,
    attributed: [
      {
        pid: 100, kind: 'server', ticketId: null, label: 'api', serverId: null,
        attribution: 'attributable',
        cost: { pid: 100, rssBytes: 80 * 1024 ** 2, cpuPct: 35, procCount: 1, startedMs: 100_000 },
        cwd: null, comm: 'node',
      },
    ],
    unattributed: [],
    totals: { rssBytes: 80 * 1024 ** 2, cpuPct: 35 },
  },
  waste: [],
  history: [{ takenMs: 200_000, totals: { rssBytes: 80 * 1024 ** 2, cpuPct: 35 } }],
};

describe('trendSummary (RS-8)', () => {
  it('builds the one-sentence text alternative from the host-formatted totals', () => {
    const state = buildResourcesState(reading, []);
    expect(trendSummary(state)).toBe('CPU 35%, steady. RSS 80.0 MB.');
  });

  it('never invents a value: an unmeasured reading keeps the em-dash', () => {
    const state = buildResourcesState(
      { supported: false, degraded: false, inventory: null, waste: [], history: [], skipped: 0, fastLane: false },
      [],
    );
    expect(trendSummary(state)).toBe('CPU —, steady. RSS —.');
  });
});

describe('trendEmptyText (RS-9)', () => {
  it('names the position out of the ring capacity for one sample', () => {
    const state = buildResourcesState(reading, []);
    expect(trendEmptyText(state)).toBe('Measuring… (1 of 150 samples)');
  });

  it('says zero before the first sample', () => {
    const state = buildResourcesState(
      { ...reading, history: [] },
      [],
    );
    expect(trendEmptyText(state)).toBe('Measuring… (0 of 150 samples)');
  });
});
