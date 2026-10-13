import { describe, it, expect, vi } from 'vitest';
import { QuotaOps, type QuotaStatusSink } from './quotaOps.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';

function sink(): QuotaStatusSink & { sets: Array<[string, string, boolean]>; hides: number } {
  const sets: Array<[string, string, boolean]> = [];
  let hides = 0;
  return {
    sets,
    get hides() {
      return hides;
    },
    set: (text, tooltip, warning) => sets.push([text, tooltip, warning]),
    hide: () => {
      hides++;
    },
  };
}

const ok = (core: QuotaSnapshot['core'], used: number): QuotaSnapshot => ({
  core,
  state: 'ok',
  windows: [{ label: '7-day', usedPct: used, resetsAt: null }],
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

function make(over: {
  snapshots?: QuotaSnapshot[];
  get?: (core: string) => QuotaSnapshot | undefined;
  thresholdPct?: () => number | undefined;
}) {
  const status = sink();
  const notify = vi.fn();
  const ops = new QuotaOps({
    service: {
      snapshots: () => over.snapshots ?? [],
      get: (core) => over.get?.(core),
    },
    thresholdPct: over.thresholdPct ?? (() => 80),
    coreLabel: (core) => core,
    status,
    notify,
  });
  return { ops, status, notify };
}

describe('QuotaOps.applyStatus', () => {
  it('hides the badge when no core has a readable window', () => {
    const { ops, status } = make({ snapshots: [{ core: 'opencode', state: 'unknown', reason: 'x' }] });
    ops.applyStatus();
    expect(status.hides).toBe(1);
    expect(status.sets).toHaveLength(0);
  });

  it('sets the badge text, tooltip and warning from the snapshots', () => {
    const { ops, status } = make({ snapshots: [ok('codex', 90)] });
    ops.applyStatus();
    expect(status.sets).toHaveLength(1);
    const [text, tooltip, warning] = status.sets[0]!;
    expect(text).toContain('codex 90%');
    expect(tooltip).toContain('Warn threshold 80%');
    expect(warning).toBe(true);
  });

  it('uses the snapshots passed in rather than re-reading the service', () => {
    const { ops, status } = make({ snapshots: [ok('codex', 10)] });
    ops.applyStatus([ok('claude', 50)]);
    expect(status.sets[0]![0]).toContain('claude 50%');
  });

  it('defaults the threshold to 80 when the manifest carries none', () => {
    const { ops, status } = make({ snapshots: [ok('codex', 80)], thresholdPct: () => undefined });
    ops.applyStatus();
    expect(status.sets[0]![2]).toBe(true);
  });
});

describe('QuotaOps.warnBeforeLaunch', () => {
  it('warns when the resolved core is at or above the threshold', () => {
    const { ops, notify } = make({ get: () => ok('codex', 85) });
    ops.warnBeforeLaunch('codex');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('codex is at 85%'));
  });

  it('stays silent below the threshold or for an unknown core', () => {
    const below = make({ get: () => ok('codex', 79) });
    below.ops.warnBeforeLaunch('codex');
    expect(below.notify).not.toHaveBeenCalled();

    const unknown = make({ get: () => undefined });
    unknown.ops.warnBeforeLaunch('codex');
    expect(unknown.notify).not.toHaveBeenCalled();
  });
});
