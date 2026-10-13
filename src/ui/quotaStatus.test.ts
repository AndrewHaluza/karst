import { describe, it, expect } from 'vitest';
import { buildQuotaIndicator } from './quotaStatus.js';
import type { QuotaSnapshot } from '../agent/quota/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const label = (core: string): string => core;

const ok = (core: QuotaSnapshot['core'], used: number, resetsAt: string | null = null): QuotaSnapshot => ({
  core,
  state: 'ok',
  windows: [{ label: '7-day', usedPct: used, resetsAt }],
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

const unknown = (core: QuotaSnapshot['core']): QuotaSnapshot => ({ core, state: 'unknown', reason: 'nope' });

describe('buildQuotaIndicator', () => {
  it('is null when no core has a readable window', () => {
    expect(buildQuotaIndicator([], 80, label, NOW)).toBeNull();
    expect(buildQuotaIndicator([unknown('codex')], 80, label, NOW)).toBeNull();
  });

  it('shows the tightest used-% per known core and hides unknown ones', () => {
    const indicator = buildQuotaIndicator(
      [ok('claude', 34), ok('codex', 76), unknown('opencode')],
      80,
      label,
      NOW,
    );
    expect(indicator?.text).toBe('$(dashboard) claude 34% · codex 76%');
    expect(indicator?.warning).toBe(false);
  });

  it('turns amber at or above the threshold', () => {
    const indicator = buildQuotaIndicator([ok('codex', 80)], 80, label, NOW);
    expect(indicator?.warning).toBe(true);
  });

  it('names each window and the threshold in the tooltip', () => {
    const indicator = buildQuotaIndicator([ok('codex', 76, '2026-01-02T00:00:00.000Z')], 80, label, NOW);
    expect(indicator?.tooltip).toContain('codex: 76% of 7-day · resets 2026-01-02T00:00:00.000Z');
    expect(indicator?.tooltip).toContain('Warn threshold 80%');
  });

  it('drops a window whose reset instant has already passed', () => {
    const indicator = buildQuotaIndicator([ok('codex', 95, '2025-12-25T00:00:00.000Z')], 80, label, NOW);
    expect(indicator).toBeNull();
  });

  it('keeps a core whose open window is below threshold when its tighter one expired', () => {
    const mixed: QuotaSnapshot = {
      core: 'codex',
      state: 'ok',
      windows: [
        { label: '5-hour', usedPct: 95, resetsAt: '2025-12-25T00:00:00.000Z' },
        { label: '7-day', usedPct: 20, resetsAt: '2026-01-03T00:00:00.000Z' },
      ],
      source: 'test',
      readAt: '2025-12-25T00:00:00.000Z',
    };
    const indicator = buildQuotaIndicator([mixed], 80, label, NOW);
    expect(indicator?.text).toBe('$(dashboard) codex 20%');
    expect(indicator?.warning).toBe(false);
  });
});
