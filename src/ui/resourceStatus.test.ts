import { describe, expect, it } from 'vitest';
import type { ResourceReading } from '../runtime/resourceMonitor.js';
import { buildResourceIndicator } from './resourceStatus.js';

function reading(overrides: Partial<ResourceReading>): ResourceReading {
  return {
    supported: true,
    degraded: false,
    skipped: 0,
    fastLane: false,
    inventory: {
      takenMs: 1_000,
      cwdProbes: 0,
      attributed: [
        {
          pid: 100,
          kind: 'server',
          ticketId: 7,
          label: 'web',
          serverId: 1,
          attribution: 'attributable',
          cost: { pid: 100, rssBytes: 60, cpuPct: 50, procCount: 3, startedMs: 1 },
          cwd: '/wt/x',
          comm: 'npm',
        },
      ],
      unattributed: [],
      totals: { rssBytes: 60, cpuPct: 50 },
    },
    waste: [],
    history: [{ takenMs: 1_000, totals: { rssBytes: 60, cpuPct: 50 } }],
    ...overrides,
  };
}

describe('buildResourceIndicator', () => {
  it('returns null on an unsupported platform', () => {
    expect(buildResourceIndicator(reading({ supported: false }))).toBeNull();
  });

  it('returns null before anything is measured', () => {
    expect(buildResourceIndicator(reading({ inventory: null }))).toBeNull();
  });

  it('shows the waste count in amber when findings exist', () => {
    const r = reading({
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
    });
    const indicator = buildResourceIndicator(r);
    expect(indicator?.warning).toBe(true);
    expect(indicator?.text).toBe('$(warning) Karst: 1 leaked');
    expect(indicator?.tooltip).toContain('0.1 KB');
  });

  it('caps the waste tooltip at five lines plus an overflow line', () => {
    const waste = Array.from({ length: 7 }, (_, i) => ({
      kind: 'ticket-finished' as const,
      pid: 100 + i,
      serverId: i + 1,
      ticketId: 7,
      reason: `finding ${i}`,
      rssBytes: 1,
      killable: true,
    }));
    const indicator = buildResourceIndicator(reading({ waste }));
    const lines = indicator!.tooltip.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('…and 2 more');
  });

  it('shows a plain meter when nothing is leaked', () => {
    const indicator = buildResourceIndicator(reading({}));
    expect(indicator?.warning).toBe(false);
    expect(indicator?.text).toBe('$(pulse) Karst 50% · 60 B');
    expect(indicator?.tooltip).toContain('3 processes attributed');
  });

  it('renders an unmeasured cpuPct as an em-dash', () => {
    const indicator = buildResourceIndicator(
      reading({
        inventory: {
          takenMs: 1_000,
          cwdProbes: 0,
          attributed: [],
          unattributed: [],
          totals: { rssBytes: 60, cpuPct: null },
        },
      }),
    );
    expect(indicator?.text).toBe('$(pulse) Karst — · 60 B');
  });
});
